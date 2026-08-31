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
  config: z.object({
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
  }),
  requires: [],
  runtime: { target: 'any' },
});

// Executor decisions (M3 + M7, recorded in STATUS):
// - Positions come from the fixed signal names gps.latitude / gps.longitude
//   (the def's config has no signal-name knobs); samples missing either signal
//   are skipped and counted.
// - Lookups are per unique position (rounded to 4 decimals, ~11 m) with a TTL
//   cache, NOT batched across samples: batching would buffer the input while
//   downstream consumers of the same source wait on ts-merged channels, which
//   deadlocks bounded fan-out graphs. At 1 Hz GPS this is at most ~1 request/s
//   on a cache-cold track.
// - No-answer samples (untagged OSM way, no HERE match, no Google coverage)
//   emit NO record and are counted in the step summary.
// - API keys via ctx.secrets logical names google-roads-api-key /
//   here-api-key; OSM resolves no secret at all. HTTP via ctx.http so the
//   smoke script runs every provider offline.
// - OSM throttling is ENFORCED here (public Overpass etiquette): >= ~1 s
//   between calls (jittered), an identifying User-Agent, and on 429/5xx one
//   back-off retry then a clear node failure. Public instances are for
//   demo/light use; self-hosted Overpass is the scale path.

export type SpeedLimitProvider = 'google_roads' | 'here' | 'osm';

export const GOOGLE_ROADS_URL = 'https://roads.googleapis.com/v1/speedLimits';
export const HERE_ROUTE_MATCH_URL = 'https://routematching.hereapi.com/v8/match/routelinks';
export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// Overpass etiquette: identify the client and give operators a contact handle.
export const OVERPASS_USER_AGENT = 'xorgate-workflows/2 (speed-limit connector; https://xorgate.io)';
export const OSM_MIN_INTERVAL_MS = 1000;
export const OSM_JITTER_MS = 250;
export const OSM_BACKOFF_MS = 3000;
export const OSM_SEARCH_RADIUS_M = 30;

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

interface RoadsResponse {
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

interface HereRouteMatchResponse {
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

export function buildOverpassRequest(lat: number, lng: number): { url: string; init: RequestInit } {
  const query =
    `[out:json][timeout:10];` +
    `way(around:${OSM_SEARCH_RADIUS_M},${roundCoord(lat)},${roundCoord(lng)})["highway"]["maxspeed"];` +
    `out tags 8;`;
  return {
    url: OVERPASS_URL,
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

interface OverpassResponse {
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

// --- Throttle (OSM politeness) ---------------------------------------------------

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Minimum-interval request throttle with jitter. Exported (with an injectable
 * sleep) so the smoke script can assert the pacing without waiting on real
 * clocks.
 */
export class RequestThrottle {
  private nextAllowedAt = 0;
  constructor(
    private readonly minIntervalMs: number,
    private readonly jitterMs: number,
    private readonly sleep: (ms: number) => Promise<void> = realSleep,
  ) {}

  async wait(): Promise<void> {
    const now = Date.now();
    if (now < this.nextAllowedAt) await this.sleep(this.nextAllowedAt - now);
    this.nextAllowedAt = Date.now() + this.minIntervalMs + Math.floor(Math.random() * this.jitterMs);
  }
}

// --- Executor ---------------------------------------------------------------------

interface CacheEntry {
  at: number;
  lookup: SpeedLimitLookup;
}

type ConnectorConfig = z.infer<typeof def.config>;

async function fetchLookup(
  provider: SpeedLimitProvider,
  lat: number,
  lng: number,
  apiKey: string | null,
  http: typeof fetch,
  throttle: RequestThrottle | null,
): Promise<SpeedLimitLookup> {
  if (provider === 'google_roads') {
    const res = await http(buildGoogleRoadsUrl(lat, lng, apiKey ?? ''));
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Google Roads request failed (HTTP ${res.status}): ${body || 'no body'}`);
    }
    return parseGoogleRoadsResponse((await res.json()) as RoadsResponse);
  }

  if (provider === 'here') {
    const { url, init } = buildHereRequest(lat, lng, apiKey ?? '');
    const res = await http(url, init);
    if (res.status === 401 || res.status === 403) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`HERE rejected the API key (HTTP ${res.status}): ${body || 'no body'}`);
    }
    // Route matching answers 400 for positions it cannot match to a road
    // (off-road GPS); that is a per-position no-answer, not a node failure.
    if (res.status === 400) return { speedLimitKph: null };
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`HERE request failed (HTTP ${res.status}): ${body || 'no body'}`);
    }
    return parseHereResponse((await res.json()) as HereRouteMatchResponse);
  }

  // OSM/Overpass: throttled, one back-off retry on 429/5xx, then a clear failure.
  const attempt = async (): Promise<{ ok: true; lookup: SpeedLimitLookup } | { ok: false; status: number; body: string }> => {
    await throttle?.wait();
    const { url, init } = buildOverpassRequest(lat, lng);
    const res = await http(url, init);
    if (res.status === 429 || res.status >= 500) {
      return { ok: false, status: res.status, body: (await res.text().catch(() => '')).slice(0, 200) };
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Overpass request failed (HTTP ${res.status}): ${body || 'no body'}`);
    }
    return { ok: true, lookup: parseOverpassResponse((await res.json()) as OverpassResponse) };
  };
  const first = await attempt();
  if (first.ok) return first.lookup;
  await realSleep(OSM_BACKOFF_MS);
  const second = await attempt();
  if (second.ok) return second.lookup;
  throw new Error(
    `Overpass is overloaded or unavailable (HTTP ${second.status} after one back-off retry): ` +
      `${second.body || 'no body'}. Public Overpass instances are demo-scale; self-host Overpass for production volume.`,
  );
}

export const executor = async function* connectorThirdParty(
  inputs: EngineInChannel[],
  config: unknown,
  ctx: EngineRunCtx,
): AsyncIterable<EngineEmit> {
  const cfg = def.config.parse(config) as ConnectorConfig;
  const provider = cfg.provider;

  // Org key when set, else platform key, else the seam's clear failure
  // (resolution order lives in the secrets seam); OSM skips the chain entirely.
  let apiKey: string | null = null;
  if (provider !== 'osm') {
    if (!ctx.secrets) {
      throw new Error('This engine target has no secret access; the Connector node cannot run here');
    }
    apiKey = await ctx.secrets.getSecret(provider === 'here' ? 'here-api-key' : 'google-roads-api-key');
  }
  const throttle = provider === 'osm' ? new RequestThrottle(OSM_MIN_INTERVAL_MS, OSM_JITTER_MS) : null;

  const cache = new Map<string, CacheEntry>();
  const ttlMs = cfg.cacheTtlSeconds * 1000;
  let emitted = 0;
  let requests = 0;
  let skippedNoPosition = 0;
  let skippedByCap = 0;
  let noCoverage = 0;

  const lookup = async (lat: number, lng: number): Promise<SpeedLimitLookup | 'capped'> => {
    const key = `${roundCoord(lat)},${roundCoord(lng)}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.lookup;
    if (requests >= cfg.maxLookupsPerRun) return 'capped';
    requests += 1;
    const result = await fetchLookup(provider, lat, lng, apiKey, ctx.http, throttle);
    cache.set(key, { at: Date.now(), lookup: result });
    return result;
  };

  for await (const sample of telemetrySamples(requireInput(inputs, 'positions'))) {
    // Accept both position namings: devices emit gps.lat/gps.lon, older demo
    // templates/CSVs use the long forms (Phase 6.10 — same fix as
    // telemetry-derivative.ts).
    const lat = sample.signals['gps.latitude'] ?? sample.signals['gps.lat'];
    const lng = sample.signals['gps.longitude'] ?? sample.signals['gps.lon'];
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      skippedNoPosition += 1;
      continue;
    }
    const entry = await lookup(lat, lng);
    if (entry === 'capped') {
      skippedByCap += 1;
      continue;
    }
    if (entry.speedLimitKph === null) {
      noCoverage += 1;
      continue;
    }
    emitted += 1;
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
  ctx.setSummary(
    `${emitted} speed-limit record(s) via ${provider}, ${requests} lookup(s)` +
      (skippedByCap > 0 ? `, ${skippedByCap} skipped by lookup cap` : '') +
      (noCoverage > 0 ? `, ${noCoverage} without coverage` : '') +
      (skippedNoPosition > 0 ? `, ${skippedNoPosition} without position` : ''),
  );
};
