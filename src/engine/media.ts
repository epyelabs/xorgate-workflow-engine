import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import * as jpeg from 'jpeg-js';
import { BoundedChannel } from './channel';

/**
 * ffmpeg + JPEG plumbing for the media executors. ffmpeg is SPAWNED, not
 * wrapped (no fluent-ffmpeg): the container installs it via apt, dev machines
 * point FFMPEG_PATH at a binary (the smoke script uses the ffmpeg-static
 * devDependency). Frames travel between nodes as raw RGBA buffers
 * (FramePayload); JPEG encode/decode happens only at the graph edges (decode
 * from mjpeg, visualization artifacts) via the pure-JS jpeg-js, so the Lambda
 * bundles need no native image library.
 */

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

const QUIET_ARGS = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

function lastLines(text: string, n = 3): string {
  const lines = text.trim().split('\n');
  return lines.slice(-n).join(' | ');
}

/**
 * Runs ffmpeg with `args` producing an mjpeg stream on stdout, and yields one
 * Buffer per JPEG frame. Frame boundaries are EOI markers (FF D9), which is
 * reliable for ffmpeg's mjpeg output (entropy-coded FF bytes are stuffed as
 * FF 00). Iteration backpressure propagates to ffmpeg through the stdout pipe.
 */
export async function* mjpegFrames(args: string[]): AsyncIterable<Buffer> {
  const child = spawn(ffmpegPath(), [...QUIET_ARGS, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrTail = '';
  child.stderr.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-4096);
  });
  const exit = new Promise<number>((resolve, reject) => {
    child.on('error', reject); // spawn failure (ffmpeg missing)
    child.on('close', (code) => resolve(code ?? -1));
  });
  exit.catch(() => {}); // observed below; avoid an unhandled rejection on early return
  const EOI = Buffer.from([0xff, 0xd9]);
  try {
    let pending: Buffer = Buffer.alloc(0);
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0;
      for (;;) {
        const eoi = pending.indexOf(EOI, start);
        if (eoi === -1) break;
        yield pending.subarray(start, eoi + 2);
        start = eoi + 2;
      }
      // Copy the remainder so yielded frames do not pin the whole backlog.
      pending = start > 0 ? Buffer.from(pending.subarray(start)) : pending;
    }
    const code = await exit;
    if (code !== 0) {
      throw new Error(`ffmpeg exited with code ${code}: ${lastLines(stderrTail) || 'no stderr'}`);
    }
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

/** Buffered exact-length reads over a readable stream. */
export class StreamReader {
  private readonly it: AsyncIterator<Buffer>;
  private pending: Buffer = Buffer.alloc(0);

  constructor(stream: Readable) {
    this.it = (stream as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  }

  async readExact(n: number): Promise<Buffer> {
    const out = await this.tryReadExact(n);
    if (!out) throw new Error(`stream ended before ${n} bytes`);
    return out;
  }

  /** Like readExact, but a clean end-of-stream at a chunk boundary returns null. */
  async tryReadExact(n: number): Promise<Buffer | null> {
    while (this.pending.length < n) {
      const r = await this.it.next();
      if (r.done) {
        if (this.pending.length === 0) return null;
        throw new Error(`stream ended after ${this.pending.length} of ${n} bytes`);
      }
      this.pending = this.pending.length ? Buffer.concat([this.pending, r.value]) : r.value;
    }
    const out = this.pending.subarray(0, n);
    this.pending = this.pending.subarray(n);
    return out;
  }
}

function writeAll(writable: Writable, buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    writable.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * A persistent ffmpeg process scaling raw RGBA frames 1:1 (video.scale),
 * PIPELINED rather than lockstep: ffmpeg's stdio layer buffers ~32 KB of input
 * before delivering the first packet, so demanding output frame N right after
 * writing input frame N deadlocks whenever a frame is smaller than that. A
 * background reader drains stdout into a queue; callers write() each input
 * frame, opportunistically takeReady() completed frames, and finish() flushes
 * the pipeline tail. Output order is input order (scale is 1:1), so callers
 * pair outputs with a FIFO of per-frame metadata.
 */
export class RawFrameScaler {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exit: Promise<number>;
  private readonly queue: BoundedChannel<Buffer>;
  private readonly readerTask: Promise<void>;
  private readerError: Error | null = null;
  private stderrTail = '';

  constructor(
    inWidth: number,
    inHeight: number,
    public readonly outWidth: number,
    public readonly outHeight: number,
  ) {
    const outBytes = outWidth * outHeight * 4;
    this.child = spawn(
      ffmpegPath(),
      [
        ...QUIET_ARGS,
        '-f', 'rawvideo',
        '-pixel_format', 'rgba',
        '-video_size', `${inWidth}x${inHeight}`,
        '-i', 'pipe:0',
        '-vf', `scale=${outWidth}:${outHeight}:flags=bilinear`,
        '-f', 'rawvideo',
        '-pix_fmt', 'rgba',
        '-flush_packets', '1',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child.stderr.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-4096);
    });
    this.exit = new Promise<number>((resolve, reject) => {
      this.child.on('error', reject);
      this.child.on('close', (code) => resolve(code ?? -1));
    });
    this.exit.catch(() => {});
    // Effectively unbounded: real depth is capped by how many frames the caller
    // has written and not yet taken, which upstream channel capacity bounds.
    const queue = new BoundedChannel<Buffer>(4096);
    this.queue = queue;
    const reader = new StreamReader(this.child.stdout);
    this.readerTask = (async () => {
      try {
        for (;;) {
          const frame = await reader.tryReadExact(outBytes);
          if (!frame) break;
          await queue.push(frame);
        }
      } catch (err) {
        this.readerError = err instanceof Error ? err : new Error(String(err));
      } finally {
        queue.close();
      }
    })();
  }

  private fail(context: string): never {
    throw new Error(`ffmpeg scale ${context}: ${lastLines(this.stderrTail) || 'no stderr'}`);
  }

  /** Feeds one input frame. The reader keeps stdout drained, so this cannot deadlock. */
  async write(image: Buffer): Promise<void> {
    try {
      await writeAll(this.child.stdin, image);
    } catch {
      this.fail('rejected input');
    }
  }

  /** A completed output frame if one is ready, else null (never blocks on ffmpeg). */
  async takeReady(): Promise<Buffer | null> {
    if (this.queue.depth === 0) return null;
    const r = await this.queue.take();
    return r.done ? null : r.value;
  }

  /** Ends the input and yields the remaining output frames; verifies a clean exit. */
  async *finish(): AsyncIterable<Buffer> {
    this.child.stdin.end();
    for await (const frame of this.queue) yield frame;
    await this.readerTask;
    if (this.readerError) this.fail(`output stream broke (${this.readerError.message})`);
    const code = await this.exit;
    if (code !== 0) this.fail(`exited with code ${code}`);
  }

  destroy(): void {
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
    this.queue.cancel();
  }
}

/** Decodes a JPEG to a raw RGBA buffer. */
export function decodeJpegToRgba(buf: Buffer): { width: number; height: number; data: Buffer } {
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
  return {
    width: img.width,
    height: img.height,
    data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length),
  };
}

/** Encodes a raw RGBA buffer as JPEG. */
export function encodeRgbaToJpeg(
  data: Buffer,
  width: number,
  height: number,
  quality = 80,
): Buffer {
  return jpeg.encode({ data, width, height }, quality).data;
}
