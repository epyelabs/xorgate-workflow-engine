import { z } from 'zod';
import { requireInput, telemetrySamples } from '../../engine/helpers';
import type { EngineEmit, EngineInChannel, EngineRunCtx } from '../types';
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
export type SpeedLimitProvider = 'google_roads' | 'here' | 'osm';

export const GOOGLE_ROADS_URL = 'https://roads.googleapis.com/v1/speedLimits';
export const HERE_ROUTE_MATCH_URL = 'https://routematching.hereapi.com/v8/match/routelinks';
export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// Overpass etiquette: identify the client and give operators a contact handle.
export const OVERPASS_USER_AGENT = 'xorgate-workflows/2 (speed-limit connector; https://xorgate.io)';
export const OSM_MIN_INTERVAL_MS = 1000;
export const OSM_JITTER_MS = 250;
export const OSM_SEARCH_RADIUS_M = 30;
/** Default pacing per provider (requests per second), when `maxRequestsPerSecond` is unset. */
export const DEFAULT_REQUESTS_PER_SECOND: Record<SpeedLimitProvider, number> = { osm: 1, here: 5, google_roads: 10 };
export const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
/** A Retry-After longer than this is not waited out: the lookup fails (or is skipped) instead. */
export const MAX_RETRY_AFTER_MS = 60000;
/** maxErrorRatio is enforced mid-run only once this many lookups were made (and always at the end). */
export const MIN_LOOKUPS_FOR_ERROR_RATIO = 10;

const configSchema = z.object({
  provider: z
    .enum(['google_roads', 'here', 'osm'])
    .default('google_roads')
    .describe(
      'Data provider. Google Roads: best snap-to-road quality, requires the Google speed-limits ' +
        'licensing on the API key. HERE: available on the standard tier (org or platform key). ' +
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
      'Request pacing (token bucket, burst 1). Default per provider: OSM 1 (plus up to 250 ms jitter), HERE 5, Google Roads 10.',
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
    .describe('Per-request timeout, body included (default 10000)'),
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

export interface HereRouteMatchResponse {
  response?: {
    route?: Array<{
      leg?: Array<{
        link?: Array<{
          attributes?: {
            SPEED_LIMITS_FCN?: Array<{
              FROM_REF_SPEED_LIMIT?: string | number;
              TO_REF_SPEED_LIMIT?: string | number;
            }>;
          };
        }>;
      }>;
    }>;
  };
}

function hereLimitValue(v: string | number | undefined): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  // 0 = unknown, 999 = HERE's "unlimited" marker: neither is a posted limit.
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n >= 999) return null;
  return n;
}

/** First matched link with a usable speed-limit attribute; null = no answer. */
export function parseHereResponse(data: HereRouteMatchResponse): SpeedLimitLookup {
  for (const route of data.response?.route ?? []) {
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
function errorBudgetExceeded(c: Counters, ratio: number, final: boolean): boolean {
  if (c.errors === 0 || c.requests === 0) return false;
  if (c.requests >= MIN_LOOKUPS_FOR_ERROR_RATIO) return c.errors / c.requests > ratio;
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

  try {
    // Org key when set, else platform key, else the seam's clear failure
    // (resolution order lives in the secrets seam); OSM skips the chain entirely.
    let apiKey: string | null = null;
    if (provider !== 'osm') {
      if (!ctx.secrets) {
        throw new Error('This engine target has no secret access; the Connector node cannot run here');
      }
      apiKey = await ctx.secrets.getSecret(provider === 'here' ? 'here-api-key' : 'google-roads-api-key');
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
      timeoutMs: cfg.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      osmEndpoint: cfg.osmEndpoint,
      stats: c.stats,
    };

    const cache = new Map<string, CacheEntry>();
    const ttlMs = cfg.cacheTtlSeconds * 1000;
    let lastError = '';
    const checkErrorBudget = (final: boolean): void => {
      if (!errorBudgetExceeded(c, cfg.maxErrorRatio, final)) return;
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
    throw new Error(`${message} [${countsText(provider, c)}]`);
  } finally {
    ctx.setSummary(countsText(provider, c));
  }
};
