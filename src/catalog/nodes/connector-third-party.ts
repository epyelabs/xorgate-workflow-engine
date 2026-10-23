import { z } from 'zod';
import { requireInput, telemetrySamples } from '../../engine/helpers';
import type { EngineEmit, EngineInChannel, EngineRunCtx, TelemetrySample } from '../types';
import { defineNode } from '../types';

// Third-party data connector; the provider is node config. All three providers
// share the telemetry-in / json:speed_limit-out signature, so a graph switches
// provider by editing one config field. The json:speed_limit record shape is
// PINNED (M3): { ts, speedLimitKph, placeId? } — ts is the triggering sample's
// ts, so logic.comparator's ts-tie rule applies the limit to that same sample.
// M7 adds the ADDITIVE optional `source` field (the provider that answered);
// `placeId` stays Google-only. A future provider with a different output shape
// needs either its own node type or config-dependent ports (a NodeTypeDef
// contract extension) — revisit then, not now.
export type SpeedLimitProvider = 'google_roads' | 'here' | 'here_routing' | 'osm';

export const GOOGLE_ROADS_URL = 'https://roads.googleapis.com/v1/speedLimits';
export const HERE_ROUTE_MATCH_URL = 'https://routematching.hereapi.com/v8/match/routelinks';
export const HERE_ROUTING_URL = 'https://router.hereapi.com/v8/routes';
/**
 * Waypoints (origin + vias + destination) per HERE Routing v8 request. HERE
 * bounds the count only by the HTTP request length and recommends at most 100
 * waypoints per route request (Routing v8 guide, "Waypoints overview").
 */
export const HERE_ROUTING_MAX_WAYPOINTS = 100;
/** here_routing: a sample further than this from the returned route is unmatched (default of `traceMatchRadiusM`). */
export const DEFAULT_TRACE_MATCH_RADIUS_M = 50;
/** Trace-mode defaults per provider, for the trace fields left unset. */
export const TRACE_DEFAULTS: Record<'here' | 'here_routing', { chunkPoints: number; overlapPoints: number; minSpacingM: number }> = {
  here: { chunkPoints: 1000, overlapPoints: 10, minSpacingM: 0 },
  here_routing: { chunkPoints: 50, overlapPoints: 2, minSpacingM: 10 },
};
export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// Overpass etiquette: identify the client and give operators a contact handle.
export const OVERPASS_USER_AGENT = 'xorgate-workflows/2 (speed-limit connector; https://xorgate.io)';
export const OSM_MIN_INTERVAL_MS = 1000;
export const OSM_JITTER_MS = 250;
export const OSM_SEARCH_RADIUS_M = 30;
/** Default pacing per provider (requests per second), when `maxRequestsPerSecond` is unset. */
export const DEFAULT_REQUESTS_PER_SECOND: Record<SpeedLimitProvider, number> = { osm: 1, here: 5, here_routing: 5, google_roads: 10 };
export const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
export const DEFAULT_TRACE_REQUEST_TIMEOUT_MS = 30000;
/** A Retry-After longer than this is not waited out: the lookup fails (or is skipped) instead. */
export const MAX_RETRY_AFTER_MS = 60000;
/** maxErrorRatio is enforced mid-run only once this many lookups were made (and always at the end). */
export const MIN_LOOKUPS_FOR_ERROR_RATIO = 10;

const configSchema = z.object({
  provider: z
    .enum(['google_roads', 'here', 'here_routing', 'osm'])
    .default('google_roads')
    .describe(
      'Data provider. Google Roads: best snap-to-road quality, requires the Google speed-limits ' +
        'licensing on the API key. HERE: Route Matching v8 (not available on self-serve HERE plans). ' +
        'HERE Routing (here_routing): Routing v8 routes through the GPS positions with speedLimit spans, ' +
        'works on self-serve plans; lookupMode trace only. ' +
        'OSM (Overpass): no key and no bill, community coverage varies, lookups throttled to ~1/s.',
    ),
  cacheTtlSeconds: z
    .number()
    .int()
    .positive()
    .default(300)
    .describe('How long looked-up results are cached'),
  maxLookupsPerRun: z
    .number()
    .int()
    .positive()
    .max(100000)
    .default(500)
    .describe(
      'Hard cap on provider lookups in one run; positions past it are skipped (cached positions still emit). ' +
        'Mainly protects public OSM/Overpass instances.',
    ),
  maxRequestsPerSecond: z
    .number()
    .positive()
    .max(100)
    .optional()
    .describe(
      'Request pacing (token bucket, burst 1). Default per provider: OSM 1 (plus up to 250 ms jitter), HERE 5, HERE Routing 5, Google Roads 10.',
    ),
  retry: z
    .object({
      attempts: z.number().int().min(1).max(10).default(4).describe('Total attempts per lookup, the first included'),
      baseMs: z.number().int().min(0).max(60000).default(500).describe('Back-off base; attempt n waits up to baseMs * 2^n'),
      maxMs: z.number().int().min(0).max(60000).default(8000).describe('Back-off ceiling'),
    })
    .default({})
    .describe(
      'Retries on HTTP 429 and 5xx with full-jitter exponential back-off; a Retry-After header (up to 60 s) is honoured instead.',
    ),
  requestTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(120000)
    .optional()
    .describe('Per-request timeout, body included (default 10000 in point mode, 30000 per trace chunk)'),
  onLookupError: z
    .enum(['fail', 'skip'])
    .default('fail')
    .describe(
      'fail: a lookup that still fails after its retries fails the node. skip: the position gets no answer ' +
        '(a null record with emitNoAnswer) and the run goes on, until errors exceed maxErrorRatio. A rejected API key always fails.',
    ),
  maxErrorRatio: z
    .number()
    .min(0)
    .max(1)
    .default(0.2)
    .describe(
      'skip only: the node fails once failed lookups exceed this share of lookups (enforced from 10 lookups on; with fewer, only a run where every lookup failed fails)',
    ),
  emitNoAnswer: z
    .boolean()
    .default(false)
    .describe(
      'Emit { ts, speedLimitKph: null, source, reason } for positions without a limit (reason no_answer, capped or error), ' +
        'so a downstream comparator drops the held limit instead of keeping a stale one',
    ),
  osmEndpoint: z
    .string()
    .url()
    .default(OVERPASS_URL)
    .describe('Overpass interpreter URL (a self-hosted instance for production volume)'),
  lookupMode: z
    .enum(['point', 'trace'])
    .default('point')
    .describe(
      'point: one lookup per unique position (here, google_roads, osm; live included). trace (here and ' +
        'here_routing, batch and simulation runs): the whole input is matched to roads in chunks, and every ' +
        'sample gets the limit of the road it was matched to, or null. Far fewer requests, no side-street flips. ' +
        'here_routing runs in trace mode only.',
    ),
  traceChunkPoints: z
    .number()
    .int()
    .min(2)
    .max(10000)
    .optional()
    .describe(
      'trace: points per request. Default here 1000 (Route Matching accepts up to 100,000 points / 15,000 km ' +
        'per trace); here_routing 50, at most 100 (each point is a route waypoint; HERE recommends at most 100 per request)',
    ),
  traceOverlapPoints: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe(
      'trace: points shared by consecutive chunks, so each chunk edge is matched with context (capped at ' +
        'half a chunk); each shared point takes its answer from the chunk where it is further from the edge. ' +
        'Default here 10, here_routing 2 (at least 1, so consecutive routes join)',
    ),
  traceMinSpacingM: z
    .number()
    .min(0)
    .max(1000)
    .optional()
    .describe(
      'trace: drop points closer than this to the last kept point before sending (stationary GPS). here: ' +
        'dropped samples take the answer of the last kept point; here_routing: every sample is still matched ' +
        'to the returned route by its own position. Default here 0 (every positioned sample is sent), here_routing 10.',
    ),
  traceMatchRadiusM: z
    .number()
    .min(1)
    .max(500)
    .default(DEFAULT_TRACE_MATCH_RADIUS_M)
    .describe(
      'here_routing: a sample further than this from the returned route (nearest point on its polyline) is unmatched (null limit)',
    ),
});

export const def = defineNode({
  type: 'connector.third_party',
  version: 1,
  group: 'source',
  label: 'Connector',
  description: 'Third-party speed-limit lookup along the incoming GPS stream.',
  ui: { icon: 'plug' },
  inputs: [
    { id: 'positions', label: 'GPS positions', channel: 'telemetry', cardinality: 'one', required: true },
  ],
  outputs: [
    {
      id: 'speed_limit',
      label: 'Speed limits',
      channel: 'json',
      tag: 'speed_limit',
      cardinality: 'many',
      required: false,
    },
  ],
  config: configSchema,
  requires: [],
  runtime: { target: 'any' },
});

// Executor decisions (M3 + M7, recorded in STATUS; P0.3 rate policy 2026-10):
// - Positions come from the fixed signal names gps.latitude / gps.longitude
//   (the def's config has no signal-name knobs); samples missing either signal
//   are skipped and counted.
// - Lookups are per unique position (rounded to 4 decimals, ~11 m) with a TTL
//   cache, NOT batched across samples: batching would buffer the input while
//   downstream consumers of the same source wait on ts-merged channels, which
//   deadlocks bounded fan-out graphs. At 1 Hz GPS this is at most ~1 request/s
//   on a cache-cold track.
// - No-answer samples (untagged OSM way, no HERE match, no Google coverage)
//   emit NO record by default and are counted in the step summary. With
//   `emitNoAnswer` they emit `{ ts, speedLimitKph: null, source, reason }`
//   (reason no_answer | capped | error), which keeps a downstream comparator
//   from holding a stale limit and keeps its ts merge moving.
// - API keys via ctx.secrets logical names google-roads-api-key /
//   here-api-key; OSM resolves no secret at all. HTTP via ctx.http so the
//   smoke script runs every provider offline.
// - Rate policy (P0.3), every provider: token-bucket pacing
//   (`maxRequestsPerSecond`, burst 1; OSM keeps its jitter and its
//   identifying User-Agent), retries on 429/5xx with full-jitter exponential
//   back-off or the server's Retry-After, a per-request timeout (AbortSignal on
//   ctx.http, raced so a fetch that ignores the signal still times out), and
//   an error budget (`onLookupError: 'skip'` + `maxErrorRatio`). A rejected
//   API key (401/403) always fails the node. Public Overpass instances are for
//   demo/light use; `osmEndpoint` points at a self-hosted Overpass.
// - The step summary is set in a finally, and a failure message carries the
//   lookup counts, so a failed step still says how far it got.
// - Trace mode (P1.1, `lookupMode: 'trace'`, HERE only): the whole input is
//   collected, stationary points are optionally decimated
//   (`traceMinSpacingM`), and the trace is route-matched in overlapping
//   chunks (`traceChunkPoints`, `traceOverlapPoints`), one request each,
//   paced and retried like point lookups; `maxLookupsPerRun` counts chunk
//   requests. Every sample then gets one record, in ts order:
//   `{ ts, speedLimitKph | null, source: 'here', linkId?, matched, reason? }`.
//   A failed chunk follows `onLookupError` (its samples get reason 'error');
//   the error ratio is checked once, at the end, with no minimum. Collecting
//   the input is the buffering the point-mode rule above avoids: it needs
//   batch channels that do not block a fan-out producer (elastic channels,
//   the batch default since 0.5.1; under channelMode 'bounded', a
//   channelCapacity above the sample count), and it is refused in
//   live runs, where a bounded look-ahead window would still stall a
//   ts-merging consumer of the same source.
// - here_routing (0.5.2): the same trace collection, decimation and chunking,
//   but each chunk is one HERE Routing v8 GET (/v8/routes, origin + pass-through
//   vias + destination, spans=speedLimit,names,length,segmentId), because
//   self-serve HERE plans get Route Matching at "0 per 10 s" while Routing is
//   allowed. Trace defaults differ (50 points per chunk, at most 100
//   waypoints; overlap 2, at least 1 so routes join; 10 m spacing). Each
//   section polyline (flexible polyline) is decoded, spans give each segment
//   its limit (m/s -> km/h), name and segment id, and every sample is matched
//   by its own position to the nearest point of the route of the chunk that
//   owns it (`traceMatchRadiusM`, default 50 m, else unmatched). Records:
//   `{ ts, speedLimitKph | null, source: 'here_routing', matched, roadName?, linkId?, reason? }`.
//   Point mode is refused at start (a one-point route is not a lookup).

/** One provider answer for one rounded position; null limit = no answer. */
export interface SpeedLimitLookup {
  speedLimitKph: number | null;
  placeId?: string; // Google-only, per the pinned record contract
}

function roundCoord(v: number): string {
  return v.toFixed(4);
}

// --- Google Roads ---------------------------------------------------------------

export function buildGoogleRoadsUrl(lat: number, lng: number, apiKey: string): string {
  return `${GOOGLE_ROADS_URL}?path=${roundCoord(lat)}%2C${roundCoord(lng)}&units=KPH&key=${encodeURIComponent(apiKey)}`;
}

export interface RoadsResponse {
  speedLimits?: Array<{ placeId?: string; speedLimit?: number; units?: string }>;
  snappedPoints?: Array<{ placeId?: string; originalIndex?: number }>;
}

export function parseGoogleRoadsResponse(data: RoadsResponse): SpeedLimitLookup {
  const placeId = data.snappedPoints?.[0]?.placeId;
  const limit = data.speedLimits?.find((l) => l.placeId === placeId) ?? data.speedLimits?.[0];
  return {
    speedLimitKph: typeof limit?.speedLimit === 'number' ? limit.speedLimit : null,
    ...(limit?.placeId ? { placeId: limit.placeId } : {}),
  };
}

// --- HERE (Route Matching v8 attributes) ----------------------------------------

/**
 * One-point route-match request carrying the SPEED_LIMITS_FCn attribute layer.
 * The trace is a two-row CSV of the same position (route matching needs a
 * trace, not a point); the matched link's speed-limit attribute answers for
 * the position.
 */
export function buildHereRequest(
  lat: number,
  lng: number,
  apiKey: string,
): { url: string; init: RequestInit } {
  const params = new URLSearchParams({
    apikey: apiKey,
    routematch: '1',
    mode: 'fastest;car;traffic:disabled',
    attributes: 'SPEED_LIMITS_FCn(*)',
  });
  const point = `${roundCoord(lat)},${roundCoord(lng)}`;
  return {
    url: `${HERE_ROUTE_MATCH_URL}?${params.toString()}`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: `LATITUDE,LONGITUDE\n${point}\n${point}\n`,
    },
  };
}

/** One row of the SPEED_LIMITS_FCn attribute layer on a matched link. */
export interface HereSpeedLimitRow {
  LINK_ID?: string | number;
  FROM_REF_SPEED_LIMIT?: string | number | null;
  TO_REF_SPEED_LIMIT?: string | number | null;
  /** 'K' km/h, 'M' mph. */
  UNIT?: string;
}

export interface HereLink {
  /** Permanent link id; a leading '-' means the link is driven towards its reference node. */
  linkId?: string | number;
  confidence?: number;
  attributes?: { SPEED_LIMITS_FCN?: HereSpeedLimitRow[] };
}

/** A matched trace point (Route Matching v8 `route[].waypoint[]`, schema TracePoint/WayPoint). */
export interface HereWaypoint {
  linkId?: string | number;
  routeLinkSeqNrMatched?: number;
  confidenceValue?: number;
  timestamp?: number;
  mappedPosition?: { latitude?: number; longitude?: number };
  originalPosition?: { latitude?: number; longitude?: number };
  matchDistance?: number;
}

export interface HereRoute {
  waypoint?: HereWaypoint[];
  leg?: Array<{ link?: HereLink[] }>;
}

/**
 * Route Matching v8 `/v8/match/routelinks` answer. The documented OpenAPI
 * schema puts `route` at the top level; responses have also been described
 * with a `response` wrapper (v7 compatibility), so both are read.
 */
export interface HereRouteMatchResponse {
  response?: { route?: HereRoute[]; warnings?: unknown[] };
  route?: HereRoute[];
  warnings?: unknown[];
}

function hereLimitValue(v: string | number | null | undefined): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  // 0 = unknown, 999 = HERE's "unlimited" marker: neither is a posted limit.
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n >= 999) return null;
  return n;
}

/** First matched link with a usable speed-limit attribute; null = no answer. */
export function parseHereResponse(data: HereRouteMatchResponse): SpeedLimitLookup {
  for (const route of data.response?.route ?? data.route ?? []) {
    for (const leg of route.leg ?? []) {
      for (const link of leg.link ?? []) {
        for (const attr of link.attributes?.SPEED_LIMITS_FCN ?? []) {
          const limit = hereLimitValue(attr.FROM_REF_SPEED_LIMIT) ?? hereLimitValue(attr.TO_REF_SPEED_LIMIT);
          if (limit !== null) return { speedLimitKph: limit };
        }
      }
    }
  }
  return { speedLimitKph: null };
}

// --- HERE trace mode (Route Matching v8, whole-trace matching) ---------------------

/** One trace point sent to HERE. */
export interface HereTracePoint {
  lat: number;
  lng: number;
  ts: number;
  heading?: number;
  speedKph?: number;
}

/** What one trace point matched to; `matched: false` when HERE returned no usable point for it. */
export interface HereTraceMatch {
  matched: boolean;
  speedLimitKph: number | null;
  linkId?: string;
  confidence?: number;
}

/**
 * A GPS trace as a CSV body (HERE's trace-file format: a header row of
 * attribute names, then the points in temporal order). Columns: latitude,
 * longitude, timestamp (ISO 8601 UTC) and, when every point has them,
 * heading (degrees clockwise from north) and speed_kmh.
 */
export function buildHereTraceCsv(points: HereTracePoint[]): string {
  const withHeading = points.length > 0 && points.every((p) => typeof p.heading === 'number' && Number.isFinite(p.heading));
  const withSpeed = points.length > 0 && points.every((p) => typeof p.speedKph === 'number' && Number.isFinite(p.speedKph));
  const header = ['latitude', 'longitude', 'timestamp', ...(withHeading ? ['heading'] : []), ...(withSpeed ? ['speed_kmh'] : [])];
  const rows = points.map((p) =>
    [
      p.lat.toFixed(6),
      p.lng.toFixed(6),
      new Date(p.ts).toISOString(),
      ...(withHeading ? [String(Number((p.heading as number).toFixed(1)))] : []),
      ...(withSpeed ? [String(Number((p.speedKph as number).toFixed(1)))] : []),
    ].join(','),
  );
  return `${header.join(',')}\n${rows.join('\n')}\n`;
}

/** One route-matching request for a chunk of the trace, asking for the SPEED_LIMITS_FCn layer. */
export function buildHereTraceRequest(points: HereTracePoint[], apiKey: string): { url: string; init: RequestInit } {
  const params = new URLSearchParams({
    apikey: apiKey,
    routeMatch: '1',
    mode: 'fastest;car;traffic:disabled',
    attributes: 'SPEED_LIMITS_FCn(*)',
  });
  return {
    url: `${HERE_ROUTE_MATCH_URL}?${params.toString()}`,
    init: { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: buildHereTraceCsv(points) },
  };
}

/**
 * The posted limit for the direction the link was driven: a positive link id
 * is driven away from the reference node (FROM_REF_SPEED_LIMIT), a negative
 * one towards it (TO_REF_SPEED_LIMIT). The other direction answers when the
 * driven one is empty. UNIT 'M' converts mph to km/h.
 */
export function hereLinkSpeedLimit(link: HereLink): number | null {
  const towardsRef = String(link.linkId ?? '').trim().startsWith('-');
  for (const row of link.attributes?.SPEED_LIMITS_FCN ?? []) {
    const driven = towardsRef ? row.TO_REF_SPEED_LIMIT : row.FROM_REF_SPEED_LIMIT;
    const other = towardsRef ? row.FROM_REF_SPEED_LIMIT : row.TO_REF_SPEED_LIMIT;
    const limit = hereLimitValue(driven) ?? hereLimitValue(other);
    if (limit === null) continue;
    return String(row.UNIT ?? 'K').toUpperCase() === 'M' ? Math.round(limit * 1.60934) : limit;
  }
  return null;
}

const absLinkId = (id: string | number | undefined): string => String(id ?? '').trim().replace(/^[-+]/, '');

/**
 * Maps every sent trace point to its matched link. HERE returns one matched
 * waypoint per trace point (TracePoint: `routeLinkSeqNrMatched` indexes the
 * route's links across legs, `linkId`, `confidenceValue`, `timestamp` echoed in
 * ms). When the waypoint count equals the point count they pair by order;
 * otherwise by echoed timestamp; a point with no waypoint is unmatched.
 */
export function parseHereTraceResponse(data: HereRouteMatchResponse, points: Array<{ ts: number }>): HereTraceMatch[] {
  const route = (data.response?.route ?? data.route ?? [])[0];
  const unmatched = (): HereTraceMatch => ({ matched: false, speedLimitKph: null });
  if (!route) return points.map(unmatched);
  const links = (route.leg ?? []).flatMap((leg) => leg.link ?? []);
  const byId = new Map<string, HereLink>();
  for (const link of links) if (!byId.has(absLinkId(link.linkId))) byId.set(absLinkId(link.linkId), link);
  const waypoints = route.waypoint ?? [];
  let pick: (i: number) => HereWaypoint | undefined;
  if (waypoints.length === points.length) {
    pick = (i) => waypoints[i];
  } else {
    const byTs = new Map<number, HereWaypoint>();
    for (const w of waypoints) if (typeof w.timestamp === 'number' && w.timestamp > 0 && !byTs.has(w.timestamp)) byTs.set(w.timestamp, w);
    pick = (i) => byTs.get(points[i].ts);
  }
  return points.map((_, i) => {
    const w = pick(i);
    if (!w) return unmatched();
    const seq = w.routeLinkSeqNrMatched;
    const link =
      (typeof seq === 'number' && seq >= 0 && seq < links.length ? links[seq] : undefined) ??
      (w.linkId !== undefined ? byId.get(absLinkId(w.linkId)) : undefined);
    if (!link) return unmatched();
    return {
      matched: true,
      speedLimitKph: hereLinkSpeedLimit(link),
      linkId: String(link.linkId ?? w.linkId),
      ...(typeof w.confidenceValue === 'number' ? { confidence: w.confidenceValue } : {}),
    };
  });
}

export interface TraceChunk {
  /** Points sent: [start, end). */
  start: number;
  end: number;
  /** Points this chunk answers for: [ownFrom, ownTo); the owned ranges partition [0, n). */
  ownFrom: number;
  ownTo: number;
}

/**
 * Splits n points into chunks of `chunkPoints` that share `overlapPoints`
 * with their neighbour (capped below half a chunk). Each shared stretch is
 * split down the middle: its first half is answered by the earlier chunk, the
 * rest by the later one, so every answered point has context on both sides.
 */
export function planTraceChunks(n: number, chunkPoints: number, overlapPoints: number): TraceChunk[] {
  if (n <= 0) return [];
  const size = Math.max(2, Math.floor(chunkPoints));
  const overlap = Math.min(Math.max(0, Math.floor(overlapPoints)), Math.floor((size - 1) / 2));
  const starts = [0];
  while (starts[starts.length - 1] + size < n) starts.push(starts[starts.length - 1] + size - overlap);
  return starts.map((start, k) => ({
    start,
    end: Math.min(start + size, n),
    ownFrom: k === 0 ? 0 : start + Math.floor(overlap / 2),
    ownTo: k === starts.length - 1 ? n : starts[k + 1] + Math.floor(overlap / 2),
  }));
}

/** Great-circle distance in metres. */
export function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// --- HERE Routing v8 (here_routing: routes through the trace, speedLimit spans) -------

const FLEXPOLY_TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const FLEXPOLY_INDEX: Record<string, number> = Object.fromEntries([...FLEXPOLY_TABLE].map((ch, i) => [ch, i]));

/**
 * Decodes a HERE flexible polyline (https://github.com/heremaps/flexible-polyline,
 * format v1): an unsigned varint version (1), an unsigned varint header
 * (bits 0-3 precision, 4-6 third-dimension type, 7-10 its precision), then
 * zigzag signed varints in 5-bit chunks (0x20 = more follows) over a 64-char
 * table, as deltas from the previous tuple. Arithmetic, not 32-bit bit ops, so
 * high precisions do not overflow. A third dimension is read and dropped.
 */
export function decodeFlexiblePolyline(encoded: string): Array<{ lat: number; lng: number }> {
  let pos = 0;
  const readUnsigned = (): number => {
    let result = 0;
    let factor = 1;
    for (;;) {
      if (pos >= encoded.length) throw new Error('flexible polyline: truncated value');
      const v = FLEXPOLY_INDEX[encoded[pos++]];
      if (v === undefined) throw new Error(`flexible polyline: invalid character '${encoded[pos - 1]}'`);
      result += (v & 0x1f) * factor;
      if ((v & 0x20) === 0) return result;
      factor *= 32;
    }
  };
  const readSigned = (): number => {
    const u = readUnsigned();
    return u % 2 === 1 ? -(u + 1) / 2 : u / 2;
  };
  const version = readUnsigned();
  if (version !== 1) throw new Error(`flexible polyline: unsupported version ${version}`);
  const header = readUnsigned();
  const precision = header % 16;
  const thirdDim = Math.floor(header / 16) % 8;
  const scale = 10 ** precision;
  const out: Array<{ lat: number; lng: number }> = [];
  let lat = 0;
  let lng = 0;
  while (pos < encoded.length) {
    lat += readSigned();
    lng += readSigned();
    if (thirdDim !== 0) readSigned();
    out.push({ lat: lat / scale, lng: lng / scale });
  }
  return out;
}

/**
 * One HERE Routing v8 request through a chunk of the trace: origin = first
 * point, destination = last, every point between as a pass-through via
 * (`via=lat,lng!passThrough=true`: shapes the route without splitting it into
 * sections or allowing a U-turn there), car, fast, time-independent
 * (`departureTime=any`: no live traffic or short-term closures re-routing a
 * historical trace), with the polyline and per-span speed limit, road names,
 * length and segment ids. GET; the query is built by hand so `,` and `!` stay
 * literal, as in HERE's examples.
 */
export function buildHereRoutingRequest(points: Array<{ lat: number; lng: number }>, apiKey: string): { url: string; init: RequestInit } {
  if (points.length < 2) throw new Error('buildHereRoutingRequest needs at least 2 points');
  const at = (p: { lat: number; lng: number }): string => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const query = [
    'transportMode=car',
    'routingMode=fast',
    'departureTime=any',
    `origin=${at(points[0])}`,
    ...points.slice(1, -1).map((p) => `via=${at(p)}!passThrough=true`),
    `destination=${at(points[points.length - 1])}`,
    'return=polyline',
    'spans=speedLimit,names,length,segmentId',
    `apikey=${encodeURIComponent(apiKey)}`,
  ];
  return { url: `${HERE_ROUTING_URL}?${query.join('&')}`, init: { method: 'GET' } };
}

/** One span of a Routing v8 section; `offset` indexes the section polyline's points. */
export interface HereRoutingSpan {
  offset?: number;
  length?: number;
  /** m/s; absent or null where HERE has no posted limit. */
  speedLimit?: number | null;
  names?: Array<{ value?: string; language?: string }>;
  segmentId?: string | null;
  topologySegmentId?: string | null;
}

export interface HereRoutingSection {
  polyline?: string;
  spans?: HereRoutingSpan[];
}

/** Routing v8 `/v8/routes` answer (the fields here_routing reads). */
export interface HereRoutingResponse {
  routes?: Array<{ sections?: HereRoutingSection[] }>;
  notices?: Array<{ code?: string; title?: string; severity?: string }>;
}

/** One straight piece of the returned route with the span attributes it lies in. */
export interface RouteSegment {
  a: { lat: number; lng: number };
  b: { lat: number; lng: number };
  speedLimitKph: number | null;
  roadName?: string;
  linkId?: string;
}

/**
 * The first route's sections as segments between consecutive polyline points.
 * Span k covers points offset_k .. offset_{k+1} (the last span to the end of
 * the section), so the segment from point j to j+1 takes the span with the
 * largest offset <= j. speedLimit is m/s: km/h = round(m/s * 3.6). The segment
 * id is `topologySegmentId` (what spans=segmentId returns today) or
 * `segmentId`. No route (HERE could not route the chunk) is an empty list.
 */
export function parseHereRoutingResponse(data: HereRoutingResponse): RouteSegment[] {
  const out: RouteSegment[] = [];
  for (const section of data.routes?.[0]?.sections ?? []) {
    if (typeof section.polyline !== 'string' || section.polyline === '') continue;
    const pts = decodeFlexiblePolyline(section.polyline);
    const spans = [...(section.spans ?? [])]
      .filter((sp) => typeof sp.offset === 'number')
      .sort((x, y) => (x.offset as number) - (y.offset as number));
    let k = -1;
    const segs = pts.length === 1 ? [[0, 0]] : pts.slice(0, -1).map((_, j) => [j, j + 1]);
    for (const [i, j] of segs) {
      while (k + 1 < spans.length && (spans[k + 1].offset as number) <= i) k += 1;
      const span = k >= 0 ? spans[k] : undefined;
      const mps = span?.speedLimit;
      const name = span?.names?.find((n) => typeof n.value === 'string' && n.value !== '')?.value;
      const id = span?.topologySegmentId ?? span?.segmentId;
      out.push({
        a: pts[i],
        b: pts[j],
        speedLimitKph: typeof mps === 'number' && Number.isFinite(mps) && mps > 0 ? Math.round(mps * 3.6) : null,
        ...(name ? { roadName: name } : {}),
        ...(typeof id === 'string' && id !== '' ? { linkId: id } : {}),
      });
    }
  }
  return out;
}

export interface RouteMatch {
  matched: boolean;
  speedLimitKph: number | null;
  /** Metres from the sample to the nearest point of the route; null without a route. */
  distanceM: number | null;
  roadName?: string;
  linkId?: string;
}

/**
 * Nearest point of the route to (lat, lng): each segment is projected in a
 * local equirectangular frame around the sample (sub-metre error at these
 * distances), so a sample midway along a long straight segment is as close as
 * the road, not as far as the nearest vertex. Further than `maxDistanceM` is
 * unmatched; the earlier segment wins a tie (a vertex shared by two spans).
 */
export function matchToRoute(lat: number, lng: number, segments: RouteSegment[], maxDistanceM: number): RouteMatch {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const kx = Math.cos(lat * rad) * R * rad;
  const ky = R * rad;
  let best: RouteSegment | undefined;
  let bestD2 = Number.POSITIVE_INFINITY;
  for (const seg of segments) {
    const ax = (seg.a.lng - lng) * kx;
    const ay = (seg.a.lat - lat) * ky;
    const bx = (seg.b.lng - lng) * kx;
    const by = (seg.b.lat - lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d2 = px * px + py * py;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = seg;
    }
  }
  if (!best) return { matched: false, speedLimitKph: null, distanceM: null };
  const distanceM = Math.sqrt(bestD2);
  if (distanceM > maxDistanceM) return { matched: false, speedLimitKph: null, distanceM };
  return {
    matched: true,
    speedLimitKph: best.speedLimitKph,
    distanceM,
    ...(best.roadName ? { roadName: best.roadName } : {}),
    ...(best.linkId ? { linkId: best.linkId } : {}),
  };
}

// --- OSM (Overpass) ---------------------------------------------------------------

export function buildOverpassRequest(
  lat: number,
  lng: number,
  endpoint: string = OVERPASS_URL,
): { url: string; init: RequestInit } {
  const query =
    `[out:json][timeout:10];` +
    `way(around:${OSM_SEARCH_RADIUS_M},${roundCoord(lat)},${roundCoord(lng)})["highway"]["maxspeed"];` +
    `out tags 8;`;
  return {
    url: endpoint,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': OVERPASS_USER_AGENT,
      },
      body: `data=${encodeURIComponent(query)}`,
    },
  };
}

/**
 * OSM maxspeed tag -> kph. Numeric values are kph by convention; "NN mph" and
 * "NN knots" convert; non-numeric values ("none", "signals", "variable",
 * zone refs) are no answer.
 */
export function parseMaxspeedTag(value: string | undefined): number | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  let m = /^(\d+(?:\.\d+)?)$/.exec(v);
  if (m) return Math.round(Number(m[1]));
  m = /^(\d+(?:\.\d+)?)\s*mph$/.exec(v);
  if (m) return Math.round(Number(m[1]) * 1.60934);
  m = /^(\d+(?:\.\d+)?)\s*knots$/.exec(v);
  if (m) return Math.round(Number(m[1]) * 1.852);
  return null;
}

export interface OverpassResponse {
  elements?: Array<{ tags?: Record<string, string> }>;
}

/** First nearby way with a parseable maxspeed tag; null = no tagged way. */
export function parseOverpassResponse(data: OverpassResponse): SpeedLimitLookup {
  for (const el of data.elements ?? []) {
    const limit = parseMaxspeedTag(el.tags?.maxspeed);
    if (limit !== null) return { speedLimitKph: limit };
  }
  return { speedLimitKph: null };
}

// --- Clock seam ---------------------------------------------------------------------

/**
 * Time source for pacing and back-off. Internal test seam (not exported from
 * the package root): the connector tests swap in a virtual clock so pacing and
 * Retry-After waits are asserted without real sleeps. Request timeouts use
 * real timers regardless.
 */
export interface ConnectorClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
}

const realClock: ConnectorClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: () => Math.random(),
};

export const connectorClock: ConnectorClock = { ...realClock };

/** Restores the real clock after a test swapped `connectorClock`'s members. */
export function resetConnectorClock(): void {
  Object.assign(connectorClock, realClock);
}

// --- Throttle (token bucket) ----------------------------------------------------------

/**
 * Token-bucket request pacing (burst 1 by default, i.e. at most one request
 * per 1/rate seconds), with optional jitter added to each spacing (OSM
 * politeness). Implemented as GCRA: `tat` is the theoretical arrival time of
 * the next conforming request. Calls are serialised, so concurrent callers
 * queue in order.
 */
export class RequestThrottle {
  private tat = Number.NEGATIVE_INFINITY;
  private queue: Promise<void> = Promise.resolve();
  private readonly intervalMs: number;

  constructor(
    readonly ratePerSecond: number,
    private readonly opts: { jitterMs?: number; burst?: number; clock?: ConnectorClock } = {},
  ) {
    this.intervalMs = 1000 / ratePerSecond;
  }

  wait(): Promise<void> {
    const next = this.queue.then(() => this.acquire());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async acquire(): Promise<void> {
    const clock = this.opts.clock ?? connectorClock;
    const burst = Math.max(1, this.opts.burst ?? 1);
    const now = clock.now();
    const tat = Math.max(this.tat, now);
    const allowedAt = tat - (burst - 1) * this.intervalMs;
    if (allowedAt > now) await clock.sleep(allowedAt - now);
    const jitter = this.opts.jitterMs ? Math.floor(clock.random() * this.opts.jitterMs) : 0;
    this.tat = tat + this.intervalMs + jitter;
  }
}

// --- Request policy: timeout, retries, error classes ----------------------------------

/** A failure no error budget may absorb (a rejected key): always fails the node. */
export class ConnectorFatalError extends Error {}
/** One lookup failed after its retries (or timed out): `onLookupError` decides. */
export class ConnectorLookupError extends Error {}

export interface RetryPolicy {
  attempts: number;
  baseMs: number;
  maxMs: number;
}

export interface HttpOutcome {
  status: number;
  ok: boolean;
  text: string;
}

/** Retry-After in ms (delta-seconds or HTTP-date); null when absent or unparseable. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** Full-jitter exponential back-off for retry number `retry` (0-based). */
export function backoffDelayMs(retry: number, policy: RetryPolicy, random: () => number): number {
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** retry);
  return Math.floor(random() * ceiling);
}

/**
 * One HTTP exchange under the timeout: the fetch and the body read race an
 * abort, so a fetch implementation that ignores the signal still times out.
 */
async function exchange(
  http: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  label: string,
): Promise<{ res: Response; text: string }> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ConnectorLookupError(`${label} request timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([
      Promise.resolve().then(() => http(url, { ...(init ?? {}), signal: controller.signal })),
      timedOut,
    ]);
    const text = await Promise.race([res.text().catch(() => ''), timedOut]);
    return { res, text };
  } catch (err) {
    if (err instanceof ConnectorLookupError) throw err;
    if (controller.signal.aborted) throw new ConnectorLookupError(`${label} request timed out after ${timeoutMs} ms`);
    // Network-level failure (DNS, reset): one lookup's error, not retried.
    throw new ConnectorLookupError(`${label} request failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

export interface PolicyStats {
  retries: number;
}

/**
 * Throttle, send, and retry on 429/5xx (Retry-After honoured up to
 * MAX_RETRY_AFTER_MS, else full-jitter back-off). Returns the final outcome,
 * a retryable status included once attempts run out; callers map statuses to
 * answers and errors.
 */
export async function requestWithPolicy(args: {
  http: typeof fetch;
  build: () => { url: string; init?: RequestInit };
  label: string;
  throttle: RequestThrottle | null;
  retry: RetryPolicy;
  timeoutMs: number;
  stats?: PolicyStats;
  clock?: ConnectorClock;
}): Promise<HttpOutcome & { attempts: number }> {
  const clock = args.clock ?? connectorClock;
  for (let attempt = 1; ; attempt++) {
    await args.throttle?.wait();
    const { url, init } = args.build();
    const { res, text } = await exchange(args.http, url, init, args.timeoutMs, args.label);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= args.retry.attempts) {
      return { status: res.status, ok: res.ok, text, attempts: attempt };
    }
    const retryAfter = parseRetryAfter(res.headers?.get?.('retry-after'), clock.now());
    if (retryAfter !== null && retryAfter > MAX_RETRY_AFTER_MS) {
      return { status: res.status, ok: res.ok, text, attempts: attempt };
    }
    const delay = retryAfter ?? backoffDelayMs(attempt - 1, args.retry, clock.random);
    if (args.stats) args.stats.retries += 1;
    if (delay > 0) await clock.sleep(delay);
  }
}

// --- Per-provider lookups ---------------------------------------------------------------

interface LookupDeps {
  provider: SpeedLimitProvider;
  apiKey: string | null;
  http: typeof fetch;
  throttle: RequestThrottle | null;
  retry: RetryPolicy;
  timeoutMs: number;
  osmEndpoint: string;
  stats: PolicyStats;
}

const snippet = (text: string): string => text.slice(0, 200) || 'no body';
const attemptsNote = (n: number): string => (n > 1 ? ` after ${n} attempts` : '');

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ConnectorLookupError(`${label} answered with a body that is not JSON: ${snippet(text)}`);
  }
}

async function fetchLookup(lat: number, lng: number, d: LookupDeps): Promise<SpeedLimitLookup> {
  const common = { http: d.http, throttle: d.throttle, retry: d.retry, timeoutMs: d.timeoutMs, stats: d.stats };

  if (d.provider === 'google_roads') {
    const out = await requestWithPolicy({
      ...common,
      label: 'Google Roads',
      build: () => ({ url: buildGoogleRoadsUrl(lat, lng, d.apiKey ?? '') }),
    });
    if (out.status === 401 || out.status === 403) {
      throw new ConnectorFatalError(`Google Roads rejected the API key (HTTP ${out.status}): ${snippet(out.text)}`);
    }
    if (!out.ok) {
      throw new ConnectorLookupError(
        `Google Roads request failed (HTTP ${out.status}${attemptsNote(out.attempts)}): ${snippet(out.text)}`,
      );
    }
    return parseGoogleRoadsResponse(parseJson<RoadsResponse>(out.text, 'Google Roads'));
  }

  if (d.provider === 'here_routing') {
    // Rejected at start: here_routing routes whole traces (lookupMode 'trace').
    throw new Error("provider 'here_routing' has no point lookup; it runs in lookupMode 'trace' only");
  }

  if (d.provider === 'here') {
    const out = await requestWithPolicy({
      ...common,
      label: 'HERE',
      build: () => buildHereRequest(lat, lng, d.apiKey ?? ''),
    });
    if (out.status === 401 || out.status === 403) {
      throw new ConnectorFatalError(`HERE rejected the API key (HTTP ${out.status}): ${snippet(out.text)}`);
    }
    // Route matching answers 400 for positions it cannot match to a road
    // (off-road GPS); that is a per-position no-answer, not a node failure.
    if (out.status === 400) return { speedLimitKph: null };
    if (!out.ok) {
      throw new ConnectorLookupError(
        `HERE request failed (HTTP ${out.status}${attemptsNote(out.attempts)}): ${snippet(out.text)}`,
      );
    }
    return parseHereResponse(parseJson<HereRouteMatchResponse>(out.text, 'HERE'));
  }

  const out = await requestWithPolicy({
    ...common,
    label: 'Overpass',
    build: () => buildOverpassRequest(lat, lng, d.osmEndpoint),
  });
  if (out.status === 429 || out.status >= 500) {
    throw new ConnectorLookupError(
      `Overpass is overloaded or unavailable (HTTP ${out.status}${attemptsNote(out.attempts)}): ${snippet(out.text)}. ` +
        'Public Overpass instances are demo-scale; self-host Overpass for production volume (osmEndpoint).',
    );
  }
  if (!out.ok) {
    throw new ConnectorLookupError(`Overpass request failed (HTTP ${out.status}): ${snippet(out.text)}`);
  }
  return parseOverpassResponse(parseJson<OverpassResponse>(out.text, 'Overpass'));
}

// --- Executor ---------------------------------------------------------------------

interface CacheEntry {
  at: number;
  lookup: SpeedLimitLookup | 'error';
}

type ConnectorConfig = z.infer<typeof configSchema>;
export type NoAnswerReason = 'no_answer' | 'capped' | 'error';

/** Counters shared by the summary, the error budget and failure messages. */
interface Counters {
  emitted: number;
  nullRecords: number;
  requests: number;
  errors: number;
  skippedNoPosition: number;
  skippedByCap: number;
  noCoverage: number;
  stats: PolicyStats;
}

function countsText(provider: string, c: Counters): string {
  return (
    `${c.emitted} speed-limit record(s) via ${provider}, ${c.requests} lookup(s)` +
    (c.nullRecords > 0 ? `, ${c.nullRecords} null record(s)` : '') +
    (c.skippedByCap > 0 ? `, ${c.skippedByCap} skipped by lookup cap` : '') +
    (c.noCoverage > 0 ? `, ${c.noCoverage} without coverage` : '') +
    (c.errors > 0 ? `, ${c.errors} failed lookup(s)` : '') +
    (c.stats.retries > 0 ? `, ${c.stats.retries} retr${c.stats.retries === 1 ? 'y' : 'ies'}` : '') +
    (c.skippedNoPosition > 0 ? `, ${c.skippedNoPosition} without position` : '')
  );
}

/**
 * The skip path's error budget: past MIN_LOOKUPS_FOR_ERROR_RATIO lookups the
 * failed share may not exceed `ratio`; below that sample size only a run in
 * which every lookup failed trips it (checked at the end of the input).
 */
function errorBudgetExceeded(c: Counters, ratio: number, final: boolean, minLookups = MIN_LOOKUPS_FOR_ERROR_RATIO): boolean {
  if (c.errors === 0 || c.requests === 0) return false;
  if (c.requests >= minLookups) return c.errors / c.requests > ratio;
  return final && c.errors === c.requests;
}

export const executor = async function* connectorThirdParty(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
): AsyncIterable<EngineEmit> {
  const cfg: ConnectorConfig = configSchema.parse(config);
  const provider = cfg.provider;
  const c: Counters = {
    emitted: 0,
    nullRecords: 0,
    requests: 0,
    errors: 0,
    skippedNoPosition: 0,
    skippedByCap: 0,
    noCoverage: 0,
    stats: { retries: 0 },
  };

  const label = cfg.lookupMode === 'trace' ? `${provider} (trace)` : provider;
  let traceNote = '';

  try {
    if (provider === 'here_routing' && cfg.lookupMode !== 'trace') {
      throw new Error(
        "provider 'here_routing' runs in lookupMode 'trace' only (it routes through the whole trace and matches " +
          "every sample to that route); set lookupMode: 'trace', or use provider 'here' for point lookups",
      );
    }
    if (cfg.lookupMode === 'trace') {
      if (provider !== 'here' && provider !== 'here_routing') {
        throw new Error(
          `lookupMode 'trace' supports providers 'here' and 'here_routing' only (got '${provider}'); use lookupMode 'point' for ${provider}`,
        );
      }
      if (
        provider === 'here_routing' &&
        cfg.traceChunkPoints !== undefined &&
        cfg.traceChunkPoints > HERE_ROUTING_MAX_WAYPOINTS
      ) {
        throw new Error(
          `traceChunkPoints ${cfg.traceChunkPoints} is above ${HERE_ROUTING_MAX_WAYPOINTS} for provider 'here_routing': ` +
            `every chunk point is a route waypoint and HERE recommends at most ${HERE_ROUTING_MAX_WAYPOINTS} per request`,
        );
      }
      if (ctx.mode === 'live') {
        throw new Error(
          "lookupMode 'trace' collects the whole input before matching it, so it runs in batch and simulation runs only; " +
            "use lookupMode 'point' in live runs",
        );
      }
    }
    // Org key when set, else platform key, else the seam's clear failure
    // (resolution order lives in the secrets seam); OSM skips the chain entirely.
    let apiKey: string | null = null;
    if (provider !== 'osm') {
      if (!ctx.secrets) {
        throw new Error('This engine target has no secret access; the Connector node cannot run here');
      }
      apiKey = await ctx.secrets.getSecret(
        provider === 'here' || provider === 'here_routing' ? 'here-api-key' : 'google-roads-api-key',
      );
    }
    const throttle = new RequestThrottle(cfg.maxRequestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND[provider], {
      jitterMs: provider === 'osm' ? OSM_JITTER_MS : 0,
    });
    const deps: LookupDeps = {
      provider,
      apiKey,
      http: ctx.http,
      throttle,
      retry: cfg.retry,
      timeoutMs:
        cfg.requestTimeoutMs ??
        (cfg.lookupMode === 'trace' ? DEFAULT_TRACE_REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS),
      osmEndpoint: cfg.osmEndpoint,
      stats: c.stats,
    };

    const cache = new Map<string, CacheEntry>();
    const ttlMs = cfg.cacheTtlSeconds * 1000;
    let lastError = '';
    const checkErrorBudget = (final: boolean, minLookups?: number): void => {
      if (!errorBudgetExceeded(c, cfg.maxErrorRatio, final, minLookups)) return;
      throw new Error(
        `Speed-limit lookups failing too often (${c.errors}/${c.requests} > maxErrorRatio ${cfg.maxErrorRatio})` +
          (lastError ? `; last: ${lastError}` : ''),
      );
    };

    const lookup = async (lat: number, lng: number): Promise<SpeedLimitLookup | 'capped' | 'error'> => {
      const key = `${roundCoord(lat)},${roundCoord(lng)}`;
      const hit = cache.get(key);
      if (hit && connectorClock.now() - hit.at < ttlMs) return hit.lookup;
      if (c.requests >= cfg.maxLookupsPerRun) return 'capped';
      c.requests += 1;
      let result: SpeedLimitLookup | 'error';
      try {
        result = await fetchLookup(lat, lng, deps);
      } catch (err) {
        if (!(err instanceof ConnectorLookupError) || cfg.onLookupError === 'fail') throw err;
        c.errors += 1;
        lastError = err.message;
        ctx.log(`lookup failed, skipped: ${err.message}`);
        result = 'error';
      }
      checkErrorBudget(false);
      // A failed lookup is cached like an answer, so a parked vehicle does not
      // hammer a failing provider; it is retried once the entry expires.
      cache.set(key, { at: connectorClock.now(), lookup: result });
      return result;
    };

    const nullRecord = (ts: number, reason: NoAnswerReason): EngineEmit => {
      c.nullRecords += 1;
      return { ch: 'json' as const, ts, payload: { ts, speedLimitKph: null, source: provider, reason } };
    };

    if (cfg.lookupMode === 'trace') {
      // Collect the input (safe in batch runs with elastic channels, the
      // default since 0.5.1; under channelMode 'bounded' it needs a
      // channelCapacity above the sample count; see the trace-mode notes in
      // the CHANGELOG), match it chunk by chunk, then emit one record per
      // sample in ts order.
      const samples: TelemetrySample[] = [];
      for await (const sample of telemetrySamples(requireInput(inputs, 'positions'))) samples.push(sample);
      samples.sort((a, b) => a.ts - b.ts);

      const td = TRACE_DEFAULTS[provider === 'here_routing' ? 'here_routing' : 'here'];
      const chunkPoints = cfg.traceChunkPoints ?? td.chunkPoints;
      // here_routing: consecutive chunks share at least one point, so the routes join end to start.
      const overlapPoints =
        provider === 'here_routing'
          ? Math.max(1, cfg.traceOverlapPoints ?? td.overlapPoints)
          : (cfg.traceOverlapPoints ?? td.overlapPoints);
      const minSpacingM = cfg.traceMinSpacingM ?? td.minSpacingM;

      const kept: HereTracePoint[] = [];
      const positions: Array<{ lat: number; lng: number } | null> = [];
      const keptOf: Array<number | null> = samples.map((sample) => {
        const lat = sample.signals['gps.latitude'] ?? sample.signals['gps.lat'];
        const lng = sample.signals['gps.longitude'] ?? sample.signals['gps.lon'];
        if (typeof lat !== 'number' || typeof lng !== 'number') {
          positions.push(null);
          return null;
        }
        positions.push({ lat, lng });
        const last = kept[kept.length - 1];
        if (last && minSpacingM > 0 && haversineM(last.lat, last.lng, lat, lng) < minSpacingM) {
          return kept.length - 1;
        }
        const heading = sample.signals['gps.heading'] ?? sample.signals['gps.course'];
        const speedKph = sample.signals['gps.speed'];
        kept.push({
          lat,
          lng,
          ts: sample.ts,
          ...(typeof heading === 'number' ? { heading } : {}),
          ...(typeof speedKph === 'number' ? { speedKph } : {}),
        });
        return kept.length - 1;
      });

      const chunks = planTraceChunks(kept.length, chunkPoints, overlapPoints);

      if (provider === 'here_routing') {
        // One Routing v8 request per chunk; each sample is then matched, by
        // its own position, to the route of the chunk that owns its kept point.
        const ownerOf: number[] = new Array(kept.length).fill(0);
        chunks.forEach((ch, idx) => {
          for (let i = ch.ownFrom; i < ch.ownTo; i++) ownerOf[i] = idx;
        });
        const routes: Array<RouteSegment[] | 'capped' | 'error'> = chunks.map(() => 'capped');
        for (let idx = 0; idx < chunks.length; idx++) {
          const chunk = chunks[idx];
          const points = kept.slice(chunk.start, chunk.end);
          if (points.length < 2) {
            routes[idx] = []; // one position in the whole input: nothing to route, unmatched
            continue;
          }
          if (c.requests >= cfg.maxLookupsPerRun) break; // the rest stay 'capped'
          c.requests += 1;
          const where = `points ${chunk.start}-${chunk.end - 1}`;
          try {
            const out = await requestWithPolicy({
              http: deps.http,
              throttle: deps.throttle,
              retry: deps.retry,
              timeoutMs: deps.timeoutMs,
              stats: deps.stats,
              label: 'HERE Routing',
              build: () => buildHereRoutingRequest(points, apiKey ?? ''),
            });
            if (out.status === 401 || out.status === 403) {
              throw new ConnectorFatalError(`HERE Routing rejected the API key (HTTP ${out.status}): ${snippet(out.text)}`);
            }
            if (!out.ok) {
              throw new ConnectorLookupError(
                `HERE Routing request failed (HTTP ${out.status}${attemptsNote(out.attempts)}, ${where}): ${snippet(out.text)}`,
              );
            }
            const data = parseJson<HereRoutingResponse>(out.text, 'HERE Routing');
            let segments: RouteSegment[];
            try {
              segments = parseHereRoutingResponse(data);
            } catch (err) {
              throw new ConnectorLookupError(
                `HERE Routing answer for ${where} could not be read: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            if (segments.length === 0) {
              const codes = (data.notices ?? []).map((n) => n.code ?? n.title).filter(Boolean).join(', ');
              ctx.log(`HERE Routing returned no route for ${where}${codes ? ` (${codes})` : ''}; its samples are unmatched`);
            }
            routes[idx] = segments;
          } catch (err) {
            if (!(err instanceof ConnectorLookupError) || cfg.onLookupError === 'fail') throw err;
            c.errors += 1;
            lastError = err.message;
            ctx.log(`route chunk failed, skipped: ${err.message}`);
            routes[idx] = 'error';
          }
        }
        checkErrorBudget(true, 1);

        let matchedSamples = 0;
        let unmatchedSamples = 0;
        let nullLimitSamples = 0;
        for (let i = 0; i < samples.length; i++) {
          const ts = samples[i].ts;
          const k = keptOf[i];
          const pos = positions[i];
          if (k === null || pos === null) {
            c.skippedNoPosition += 1;
            c.nullRecords += 1;
            yield { ch: 'json' as const, ts, payload: { ts, speedLimitKph: null, source: provider, matched: false, reason: 'no_position' } };
            continue;
          }
          const route = routes[ownerOf[k]];
          if (route === 'capped' || route === 'error') {
            if (route === 'capped') c.skippedByCap += 1;
            c.nullRecords += 1;
            yield { ch: 'json' as const, ts, payload: { ts, speedLimitKph: null, source: provider, matched: false, reason: route } };
            continue;
          }
          const m = matchToRoute(pos.lat, pos.lng, route, cfg.traceMatchRadiusM);
          const extra = { ...(m.roadName ? { roadName: m.roadName } : {}), ...(m.linkId ? { linkId: m.linkId } : {}) };
          if (!m.matched) {
            unmatchedSamples += 1;
            c.noCoverage += 1;
            c.nullRecords += 1;
            yield { ch: 'json' as const, ts, payload: { ts, speedLimitKph: null, source: provider, matched: false, reason: 'no_answer' } };
            continue;
          }
          matchedSamples += 1;
          if (m.speedLimitKph === null) {
            nullLimitSamples += 1;
            c.noCoverage += 1;
            c.nullRecords += 1;
            yield { ch: 'json' as const, ts, payload: { ts, speedLimitKph: null, source: provider, matched: true, ...extra, reason: 'no_answer' } };
            continue;
          }
          c.emitted += 1;
          yield { ch: 'json' as const, ts, payload: { ts, speedLimitKph: m.speedLimitKph, source: provider, matched: true, ...extra } };
        }
        traceNote =
          `, ${matchedSamples} sample(s) matched, ${unmatchedSamples} unmatched, ` +
          `${nullLimitSamples} with a null limit, ${chunks.length} chunk(s)`;
        return;
      }

      const answers: Array<HereTraceMatch | 'capped' | 'error'> = new Array(kept.length).fill('capped');
      for (const chunk of chunks) {
        if (c.requests >= cfg.maxLookupsPerRun) break; // the rest stay 'capped'
        c.requests += 1;
        const points = kept.slice(chunk.start, chunk.end);
        let matches: HereTraceMatch[] | 'error';
        try {
          const out = await requestWithPolicy({
            http: deps.http,
            throttle: deps.throttle,
            retry: deps.retry,
            timeoutMs: deps.timeoutMs,
            stats: deps.stats,
            label: 'HERE',
            build: () => buildHereTraceRequest(points, apiKey ?? ''),
          });
          if (out.status === 401 || out.status === 403) {
            throw new ConnectorFatalError(`HERE rejected the API key (HTTP ${out.status}): ${snippet(out.text)}`);
          }
          if (!out.ok) {
            throw new ConnectorLookupError(
              `HERE trace request failed (HTTP ${out.status}${attemptsNote(out.attempts)}, ` +
                `points ${chunk.start}-${chunk.end - 1}): ${snippet(out.text)}`,
            );
          }
          matches = parseHereTraceResponse(parseJson<HereRouteMatchResponse>(out.text, 'HERE'), points);
        } catch (err) {
          if (!(err instanceof ConnectorLookupError) || cfg.onLookupError === 'fail') throw err;
          c.errors += 1;
          lastError = err.message;
          ctx.log(`trace chunk failed, skipped: ${err.message}`);
          matches = 'error';
        }
        for (let i = chunk.ownFrom; i < chunk.ownTo; i++) {
          answers[i] = matches === 'error' ? 'error' : matches[i - chunk.start];
        }
      }
      checkErrorBudget(true, 1);

      let matchedPoints = 0;
      for (const a of answers) if (a !== 'capped' && a !== 'error' && a.matched) matchedPoints += 1;
      traceNote = `, ${matchedPoints}/${kept.length} trace point(s) matched in ${chunks.length} chunk(s)`;

      for (let i = 0; i < samples.length; i++) {
        const ts = samples[i].ts;
        const k = keptOf[i];
        if (k === null) {
          c.skippedNoPosition += 1;
          c.nullRecords += 1;
          yield { ch: 'json' as const, ts, payload: { ts, speedLimitKph: null, source: provider, matched: false, reason: 'no_position' } };
          continue;
        }
        const a = answers[k];
        if (a === 'capped' || a === 'error') {
          if (a === 'capped') c.skippedByCap += 1;
          c.nullRecords += 1;
          yield { ch: 'json' as const, ts, payload: { ts, speedLimitKph: null, source: provider, matched: false, reason: a } };
          continue;
        }
        const link = a.linkId !== undefined ? { linkId: a.linkId } : {};
        if (a.speedLimitKph === null) {
          c.noCoverage += 1;
          c.nullRecords += 1;
          yield { ch: 'json' as const, ts, payload: { ts, speedLimitKph: null, source: provider, ...link, matched: a.matched, reason: 'no_answer' } };
          continue;
        }
        c.emitted += 1;
        yield { ch: 'json' as const, ts, payload: { ts, speedLimitKph: a.speedLimitKph, source: provider, ...link, matched: true } };
      }
      return;
    }

    for await (const sample of telemetrySamples(requireInput(inputs, 'positions'))) {
      // Accept both position namings: devices emit gps.lat/gps.lon, older demo
      // templates/CSVs use the long forms (Phase 6.10 — same fix as
      // telemetry-derivative.ts).
      const lat = sample.signals['gps.latitude'] ?? sample.signals['gps.lat'];
      const lng = sample.signals['gps.longitude'] ?? sample.signals['gps.lon'];
      if (typeof lat !== 'number' || typeof lng !== 'number') {
        c.skippedNoPosition += 1;
        continue;
      }
      const entry = await lookup(lat, lng);
      if (entry === 'capped') {
        c.skippedByCap += 1;
        if (cfg.emitNoAnswer) yield nullRecord(sample.ts, 'capped');
        continue;
      }
      if (entry === 'error') {
        if (cfg.emitNoAnswer) yield nullRecord(sample.ts, 'error');
        continue;
      }
      if (entry.speedLimitKph === null) {
        c.noCoverage += 1;
        if (cfg.emitNoAnswer) yield nullRecord(sample.ts, 'no_answer');
        continue;
      }
      c.emitted += 1;
      yield {
        ch: 'json' as const,
        ts: sample.ts,
        payload: {
          ts: sample.ts,
          speedLimitKph: entry.speedLimitKph,
          source: provider,
          ...(entry.placeId ? { placeId: entry.placeId } : {}),
        },
      };
    }
    checkErrorBudget(true);
  } catch (err) {
    // Carry the counts on the failure: the step row shows the error, not the summary.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message} [${countsText(label, c)}${traceNote}]`);
  } finally {
    ctx.setSummary(countsText(label, c) + traceNote);
  }
};
