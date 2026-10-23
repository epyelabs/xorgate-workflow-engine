/**
 * Bounded in-process channel: the edge primitive of the streaming engine
 * (architecture.md §4.1). One channel per graph edge, single producer, single
 * consumer.
 *
 * - `block` policy (default): push() resolves only once the buffer has room,
 *   which is what backpressures a batch source down to its slowest consumer.
 * - `drop-oldest` policy (live-mode frames channels): push() always resolves
 *   immediately, evicting the oldest buffered message when full (latest wins).
 * - `unbounded` policy (0.5.1: non-frames edges in batch and simulation
 *   modes): push() always buffers and resolves immediately; `capacity` is
 *   ignored. A producer never waits on a consumer, so one silent branch of a
 *   fan-out cannot stall its siblings (the merge deadlock, FINDINGS 1.4).
 *
 * The channel also exposes its wait state (`waitingTakers`, `waitingPutters`)
 * and an operation counter (`ops`) so the engine's stall detector can tell a
 * graph that is blocked on its own channels from one that is busy.
 *
 * cancel() detaches the channel: pending and future pushes resolve immediately
 *   and are dropped, pending and future takes complete as done. The engine
 *   cancels every channel into a skipped subgraph so neither the failed
 *   branch's producers nor unrelated upstream producers can deadlock on a
 *   consumer that will never read again.
 */

export type ChannelPolicy = 'block' | 'drop-oldest' | 'unbounded';

interface Putter<T> {
  value: T;
  resolve: () => void;
}

export class BoundedChannel<T> {
  private buffer: T[] = [];
  private closed = false;
  private cancelled = false;
  private takers: Array<(result: IteratorResult<T>) => void> = [];
  private putters: Array<Putter<T>> = [];
  /** High-water mark, exposed for backpressure assertions in tests. */
  public maxDepth = 0;
  /** Messages accepted plus messages delivered; moves whenever the channel makes progress. */
  public ops = 0;

  constructor(
    public readonly capacity: number,
    public readonly policy: ChannelPolicy = 'block',
  ) {
    if (!(capacity >= 1)) throw new Error('channel capacity must be >= 1');
  }

  get depth(): number {
    return this.buffer.length;
  }

  /** Consumers parked in take() on an empty, open channel. */
  get waitingTakers(): number {
    return this.takers.length;
  }

  /** Producers parked in push() on a full channel (`block` policy only). */
  get waitingPutters(): number {
    return this.putters.length;
  }

  /** True once close() or cancel() ran. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Accepts `value`; the promise resolves when the channel has taken it (or dropped it). */
  push(value: T): Promise<void> {
    if (this.closed || this.cancelled) return Promise.resolve(); // dropped
    const taker = this.takers.shift();
    if (taker) {
      this.ops += 1;
      taker({ value, done: false });
      return Promise.resolve();
    }
    if (this.policy === 'unbounded' || this.buffer.length < this.capacity) {
      this.ops += 1;
      this.buffer.push(value);
      this.maxDepth = Math.max(this.maxDepth, this.buffer.length);
      return Promise.resolve();
    }
    if (this.policy === 'drop-oldest') {
      this.ops += 1;
      this.buffer.shift();
      this.buffer.push(value);
      return Promise.resolve();
    }
    return new Promise((resolve) => this.putters.push({ value, resolve }));
  }

  /** No more pushes; buffered messages still drain, then takes complete done. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // A producer only closes after its pushes resolved, so putters should be
    // empty here; flush them defensively (their values are dropped).
    for (const p of this.putters.splice(0)) p.resolve();
    if (this.buffer.length === 0) {
      for (const t of this.takers.splice(0)) t({ value: undefined as never, done: true });
    }
  }

  /** Detach entirely: drop the buffer, release both sides. */
  cancel(): void {
    this.cancelled = true;
    this.closed = true;
    this.buffer = [];
    for (const p of this.putters.splice(0)) p.resolve();
    for (const t of this.takers.splice(0)) t({ value: undefined as never, done: true });
  }

  take(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) {
      this.ops += 1;
      const value = this.buffer.shift()!;
      const putter = this.putters.shift();
      if (putter) {
        this.buffer.push(putter.value);
        putter.resolve();
      }
      if (this.closed && this.buffer.length === 0) this.releaseTakersDone();
      return Promise.resolve({ value, done: false });
    }
    const putter = this.putters.shift();
    if (putter) {
      this.ops += 1;
      putter.resolve();
      return Promise.resolve({ value: putter.value, done: false });
    }
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve) => this.takers.push(resolve));
  }

  private releaseTakersDone(): void {
    for (const t of this.takers.splice(0)) t({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.take(),
      return: () => {
        this.cancel();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
