import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { once } from 'node:events';
import type { WorkflowDefinition } from '../schemas/workflows';
import { coreCatalog } from '../catalog/index';
import type { Catalog } from '../catalog/pack';
import { ffmpegPath } from '../engine/media';

/**
 * --emit-video (M4, Q8): mux each visualization node's annotated frame JPEGs
 * (out/<runId>/frames/<nodeId>/<seq>.jpg) into out/<runId>/video/<nodeId>.mp4.
 * Runner-level only — no catalog change; the cloud copy never sees this.
 *
 * fps comes from the graph: the video.decode_sample node feeding the
 * visualization node's frames input (its parsed config, so the schema default
 * of 2 applies when unset). Frames are streamed to ffmpeg over image2pipe in
 * seq order, so one input JPEG = one output frame — the frame-count assert is
 * exact, whatever the seq numbering looks like.
 */

export interface EmittedVideo {
  nodeId: string;
  file: string;
  frames: number;
  fps: number;
}

/** visualization nodeId -> fps of the decode_sample feeding its frames input. */
export function visualizationFps(definition: WorkflowDefinition, catalog: Catalog = coreCatalog): Record<string, number> {
  const nodesById = new Map(definition.nodes.map((n) => [n.id, n]));
  const out: Record<string, number> = {};
  for (const node of definition.nodes) {
    if (node.type !== 'output.visualization') continue;
    let fps = 2; // decode_sample's schema default
    // Walk the frames edge(s) upstream until a decode_sample (direct in every
    // real graph today).
    const seen = new Set<string>();
    let current: string | undefined = node.id;
    while (current && !seen.has(current)) {
      seen.add(current);
      const inEdges = definition.edges.filter((e) => e.target === current);
      // A visualization node also has detections/depth edges: follow frames.
      const inEdge = inEdges.find((e) => e.targetHandle === 'frames') ?? inEdges[0];
      if (!inEdge) break;
      const upstream = nodesById.get(inEdge.source);
      if (!upstream) break;
      if (upstream.type === 'video.decode_sample') {
        const def = catalog.getNodeType(upstream.type);
        const parsed = def?.config.safeParse(upstream.data.config ?? {});
        if (parsed?.success) fps = (parsed.data as { fps: number }).fps;
        break;
      }
      current = upstream.id;
    }
    out[node.id] = fps;
  }
  return out;
}

async function muxJpegs(files: string[], fps: number, outFile: string): Promise<number> {
  mkdirSync(path.dirname(outFile), { recursive: true });
  const ff = spawn(ffmpegPath(), [
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(fps),
    '-c:v', 'mjpeg',
    '-i', '-',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    outFile,
  ]);
  let stderr = '';
  ff.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = once(ff, 'close');
  for (const file of files) {
    const stream = createReadStream(file);
    stream.pipe(ff.stdin, { end: false });
    await once(stream, 'close');
  }
  ff.stdin.end();
  const [code] = (await done) as [number];
  if (code !== 0) {
    throw new Error(`ffmpeg mux failed (exit ${code}): ${stderr.split('\n').slice(-4).join(' ')}`);
  }
  const counts = [...stderr.matchAll(/frame=\s*(\d+)/g)];
  return counts.length > 0 ? Number(counts[counts.length - 1][1]) : -1;
}

export async function emitVisualizationVideos(args: {
  runDir: string;
  definition: WorkflowDefinition;
  log: (msg: string) => void;
  /** The catalog the run used (default: core); decode_sample's fps comes from its def. */
  catalog?: Catalog;
}): Promise<EmittedVideo[]> {
  const framesRoot = path.join(args.runDir, 'frames');
  if (!existsSync(framesRoot)) {
    args.log('--emit-video: no frames/ directory on this run (no visualization node emitted frames)');
    return [];
  }
  const fpsByNode = visualizationFps(args.definition, args.catalog ?? coreCatalog);
  const emitted: EmittedVideo[] = [];
  for (const entry of readdirSync(framesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nodeId = entry.name;
    const dir = path.join(framesRoot, nodeId);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jpg'))
      .sort((a, b) => Number(path.basename(a, '.jpg')) - Number(path.basename(b, '.jpg')))
      .map((f) => path.join(dir, f));
    if (files.length === 0) continue;
    const fps = fpsByNode[nodeId] ?? 2;
    const outFile = path.join(args.runDir, 'video', `${nodeId}.mp4`);
    const muxed = await muxJpegs(files, fps, outFile);
    if (muxed !== files.length) {
      throw new Error(
        `--emit-video: muxed frame count ${muxed} != ${files.length} JPEGs for node ${nodeId}`,
      );
    }
    args.log(`--emit-video: ${nodeId} -> ${outFile} (${files.length} frames @ ${fps} fps)`);
    emitted.push({ nodeId, file: outFile, frames: files.length, fps });
  }
  return emitted;
}
