#!/usr/bin/env node
// Trim the first N seconds of a session segment into the video fixture,
// stream-copy (no re-encode), using ffmpeg-static the way engine-smoke.ts
// does on dev machines (no system ffmpeg required).
// Usage: node scripts/fixtures/trim-video.mjs <in.mp4> <out.mp4> [seconds=25] [ffmpegPath]
import { spawnSync } from 'node:child_process';

const [input, output, seconds = '25', ffmpegPath] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: trim-video.mjs <in.mp4> <out.mp4> [seconds] [ffmpegPath]');
  process.exit(1);
}
const ffmpeg = ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
const res = spawnSync(ffmpeg, ['-y', '-i', input, '-t', seconds, '-c', 'copy', output], {
  stdio: ['ignore', 'inherit', 'pipe'],
});
if (res.error) throw res.error;
const err = res.stderr.toString();
if (res.status !== 0) {
  console.error(err);
  process.exit(res.status ?? 1);
}
console.log(err.trim().split('\n').slice(-2).join('\n'));
