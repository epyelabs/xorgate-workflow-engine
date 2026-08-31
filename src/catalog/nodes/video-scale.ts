import { z } from 'zod';
import { requireInput } from '../../engine/helpers';
import { RawFrameScaler } from '../../engine/media';
import type { EngineEmit, EngineInChannel, EngineRunCtx, FramePayload } from '../types';
import { defineNode } from '../types';

const configSchema = z.object({
  width: z.number().int().min(32).max(3840).default(640).describe('Target width in pixels'),
  height: z
    .number()
    .int()
    .min(32)
    .max(2160)
    .optional()
    .describe('Target height in pixels (default: keep aspect ratio)'),
});

export const def = defineNode({
  type: 'video.scale',
  version: 1,
  group: 'video',
  label: 'Scale',
  description: 'Resizes decoded frames.',
  ui: { icon: 'scaling' },
  inputs: [{ id: 'frames', label: 'Frames', channel: 'frames', cardinality: 'one', required: true }],
  outputs: [{ id: 'frames', label: 'Frames', channel: 'frames', cardinality: 'many', required: false }],
  config: configSchema,
  requires: [],
  runtime: { target: 'media' },
});

function evenRound(v: number): number {
  return Math.max(2, Math.round(v / 2) * 2);
}

// One persistent ffmpeg rawvideo process for the whole stream (spawned on the
// first frame, when input dimensions are known). The pipeline is PIPELINED,
// not lockstep (ffmpeg buffers ~32 KB of input before its first output; see
// RawFrameScaler): inputs are written as they arrive, completed outputs are
// yielded as they surface, paired with a FIFO of per-frame metadata. A
// mid-stream dimension change fails the node rather than silently restarting
// the filter.
export const executor = async function* videoScale(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
): AsyncIterable<EngineEmit> {
  const cfg = configSchema.parse(config);
  let scaler: RawFrameScaler | null = null;
  let inWidth = 0;
  let inHeight = 0;
  let count = 0;
  const pending: Array<{ seq: number; ts: number }> = [];
  const emit = (image: Buffer): EngineEmit => {
    const meta = pending.shift();
    if (!meta) throw new Error('ffmpeg produced more frames than were written');
    count += 1;
    const payload: FramePayload = {
      seq: meta.seq,
      ts: meta.ts,
      image,
      width: scaler!.outWidth,
      height: scaler!.outHeight,
      format: 'rgba',
    };
    return { ch: 'frames' as const, ts: meta.ts, payload };
  };
  try {
    for await (const msg of requireInput(inputs, 'frames').messages) {
      if (msg.ch !== 'frames') continue;
      const frame = msg.payload as FramePayload;
      if (!scaler) {
        inWidth = frame.width;
        inHeight = frame.height;
        const outHeight = cfg.height ?? evenRound((frame.height * cfg.width) / frame.width);
        scaler = new RawFrameScaler(inWidth, inHeight, cfg.width, outHeight);
      } else if (frame.width !== inWidth || frame.height !== inHeight) {
        throw new Error(
          `frame dimensions changed mid-stream (${inWidth}x${inHeight} -> ${frame.width}x${frame.height})`,
        );
      }
      pending.push({ seq: frame.seq, ts: frame.ts });
      await scaler.write(frame.image);
      for (;;) {
        const ready = await scaler.takeReady();
        if (!ready) break;
        yield emit(ready);
      }
    }
    if (scaler) {
      for await (const image of scaler.finish()) yield emit(image);
      if (pending.length > 0) {
        throw new Error(`ffmpeg dropped ${pending.length} frame(s) at end of stream`);
      }
    }
    ctx.setSummary(
      scaler
        ? `${count} frame(s) scaled to ${scaler.outWidth}x${scaler.outHeight}`
        : 'no frames received',
    );
  } finally {
    scaler?.destroy();
  }
};
