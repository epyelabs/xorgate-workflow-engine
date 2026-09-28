import { createHmac, randomBytes } from 'node:crypto';
import type { EngineEventRecord, EngineProgressSink } from '../catalog/types';
import { WEBHOOK_ENV_PREFIX } from '../engine/child-env';
import type { WorkflowDefinition } from '../schemas/workflows';

/**
 * Local webhook delivery (0.5.0): `output.event`'s `webhook` field names an
 * endpoint; on the platform the org's endpoint registry binds the name, and
 * locally `xwe run --webhook <name>=<url>` (or `engine.run({ webhooks })`,
 * or `XWE_WEBHOOK_<NAME>`) does. Each event from a bound node is POSTed with
 * the platform's envelope and Standard Webhooks signature, so a receiver
 * written against the platform works unchanged against a laptop or a CM5.
 *
 * Best-effort by design: one attempt per event, a 10 s timeout, no retry, no
 * outbox. Failures are logged and never fail the run. The platform's
 * delivery (outbox, retries, delivery log) is not replicated here.
 */

/** The envelope's `apiVersion`; the platform's value for v1 `data` shapes. */
export const WEBHOOK_API_VERSION = '2026-09-27';
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_USER_AGENT = 'xorgate-webhooks/1';
const SECRET_PREFIX = 'whsec_';

export interface EngineWebhookOptions {
  /** Endpoint name to URL. Wins over `XWE_WEBHOOK_<NAME>` in `env`. */
  bindings?: Record<string, string>;
  /** Endpoint name to signing secret (`whsec_<base64>`). Wins over `XWE_WEBHOOK_SECRET_<NAME>`. Unsigned when absent. */
  secrets?: Record<string, string>;
  /** Accept `http:` URLs (local receivers). Default false: `https:` only. */
  allowInsecure?: boolean;
  /** Where `XWE_WEBHOOK_*` are read from. Default `process.env`; pass `{}` to ignore the environment. */
  env?: NodeJS.ProcessEnv;
  /** HTTP layer (tests). Default: global fetch. */
  fetch?: typeof fetch;
  /** Per-POST timeout. Default 10 s. */
  timeoutMs?: number;
}

/** One `webhook` name a template references, and the `output.event` nodes that reference it. */
export interface WebhookRef {
  name: string;
  nodeIds: string[];
}

/** A resolved binding; `source` says where the URL came from (for `xwe validate`). */
export interface WebhookBinding {
  name: string;
  url: string;
  secret?: string;
  source: 'option' | 'env';
}

/** dispatch-alerts -> XWE_WEBHOOK_DISPATCH_ALERTS */
export function webhookEnvVar(name: string): string {
  return WEBHOOK_ENV_PREFIX + envSuffix(name);
}

/** dispatch-alerts -> XWE_WEBHOOK_SECRET_DISPATCH_ALERTS */
export function webhookSecretEnvVar(name: string): string {
  return `${WEBHOOK_ENV_PREFIX}SECRET_${envSuffix(name)}`;
}

function envSuffix(name: string): string {
  return name.replace(/-/g, '_').toUpperCase();
}

/** The webhook names a definition's `output.event` nodes carry, in first-seen order. */
export function webhookRefsOf(definition: WorkflowDefinition): WebhookRef[] {
  const byName = new Map<string, string[]>();
  for (const node of definition.nodes) {
    if (node.type !== 'output.event') continue;
    const name = (node.data.config as Record<string, unknown> | undefined)?.webhook;
    if (typeof name !== 'string' || name.length === 0) continue;
    const ids = byName.get(name) ?? [];
    ids.push(node.id);
    byName.set(name, ids);
  }
  return [...byName].map(([name, nodeIds]) => ({ name, nodeIds }));
}

/**
 * The URL rule, mirroring the platform's endpoint policy where it applies to
 * a local run: `https:` (or `http:` with `allowInsecure`), no user-info.
 * Private and loopback hosts are allowed here (a laptop's receiver is one).
 * Returns the problem, or null. Never echoes the URL (it may be a secret).
 */
export function webhookUrlProblem(url: string, opts: { allowInsecure?: boolean } = {}): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'is not a valid URL';
  }
  if (u.protocol !== 'https:' && !(opts.allowInsecure && u.protocol === 'http:')) {
    return u.protocol === 'http:'
      ? 'must be https: (pass --allow-insecure-webhooks for a local http receiver)'
      : 'must be an https: URL';
  }
  if (u.username || u.password) return 'must not carry user-info (user:pass@)';
  return null;
}

/**
 * The HMAC key of a Standard Webhooks secret: `whsec_` + base64 of the key
 * bytes. Throws a message that never quotes the value.
 */
export function webhookSecretKey(secret: string): Buffer {
  if (typeof secret !== 'string' || !secret.startsWith(SECRET_PREFIX)) {
    throw new Error(`must be a Standard Webhooks secret: ${SECRET_PREFIX}<base64 key>`);
  }
  const b64 = secret.slice(SECRET_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    throw new Error(`must be ${SECRET_PREFIX} followed by standard base64 (A-Z a-z 0-9 + /, padded)`);
  }
  const key = Buffer.from(b64, 'base64');
  if (key.length < 16) throw new Error('key is shorter than 16 bytes; use 32 random bytes');
  return key;
}

/**
 * A new signing secret: `whsec_` + standard base64 of 32 random bytes (the
 * platform's format, and what off-the-shelf Standard Webhooks verifiers decode).
 */
export function generateWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString('base64');
}

/**
 * The `webhook-signature` header value: `v1,<base64 HMAC-SHA256(key,
 * "<id>.<timestamp>.<body>")>` per secret, space-separated (the spec's
 * multi-signature form, used by the platform during a rotation window).
 */
export function signWebhookPayload(args: {
  id: string;
  timestamp: number;
  body: string;
  secrets: string[];
}): string {
  const content = `${args.id}.${args.timestamp}.${args.body}`;
  return args.secrets
    .map((s) => `v1,${createHmac('sha256', webhookSecretKey(s)).update(content).digest('base64')}`)
    .join(' ');
}

/**
 * The request headers for one delivery. `secrets` empty = unsigned (no
 * `webhook-signature`); the id and timestamp headers are always sent.
 */
export function webhookHeaders(args: {
  id: string;
  timestamp: number;
  body: string;
  type: string;
  secrets: string[];
  deliveryId?: string;
}): Record<string, string> {
  return {
    'content-type': 'application/json',
    'user-agent': WEBHOOK_USER_AGENT,
    'webhook-id': args.id,
    'webhook-timestamp': String(args.timestamp),
    ...(args.secrets.length > 0 ? { 'webhook-signature': signWebhookPayload(args) } : {}),
    'x-xorgate-event': args.type,
    ...(args.deliveryId ? { 'x-xorgate-delivery': args.deliveryId } : {}),
  };
}

/** A time-ordered RFC 9562 version-7 UUID (48-bit ms timestamp, 74 random bits). */
export function uuidv7(nowMs: number = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(nowMs, 0, 6);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The platform envelope around a `workflow.event`, with the fields a local run cannot know set to null. */
export interface WorkflowEventEnvelope {
  id: string;
  type: 'workflow.event';
  apiVersion: string;
  createdAt: string;
  organizationId: string | null;
  workspaceId: string | null;
  data: {
    eventId: string | null;
    nodeId: string;
    kind: string;
    occurredAt: string;
    confidence: number;
    payloadSummary: string;
    payload: unknown;
    run: {
      id: string;
      templateId: string | null;
      templateVersion: number | null;
      trigger: string;
      triggerContext: unknown;
      deviceId: string | null;
    };
  };
}

export function workflowEventEnvelope(args: {
  event: EngineEventRecord;
  runId: string;
  deviceId: string | null;
  nowMs?: number;
}): WorkflowEventEnvelope {
  const now = args.nowMs ?? Date.now();
  const e = args.event;
  return {
    id: uuidv7(now),
    type: 'workflow.event',
    apiVersion: WEBHOOK_API_VERSION,
    createdAt: new Date(now).toISOString(),
    organizationId: null,
    workspaceId: null,
    data: {
      eventId: null,
      nodeId: e.nodeId,
      kind: e.kind,
      occurredAt: e.occurredAt,
      confidence: e.confidence,
      payloadSummary: e.payloadSummary,
      payload: e.payload ?? null,
      run: {
        id: args.runId,
        templateId: null,
        templateVersion: null,
        trigger: 'local',
        triggerContext: null,
        deviceId: args.deviceId,
      },
    },
  };
}

/**
 * Resolves each referenced name to a URL (and optional secret): options
 * first, then `XWE_WEBHOOK_<NAME>` / `XWE_WEBHOOK_SECRET_<NAME>`. URL and
 * secret resolve independently. Names with no URL are returned in `unbound`.
 * Throws (naming the webhook, never the value) on a URL or secret that breaks
 * the policy: that is a usage error, nothing should run.
 */
export function resolveWebhookBindings(
  refs: WebhookRef[],
  opts: EngineWebhookOptions = {},
): { bound: WebhookBinding[]; unbound: WebhookRef[] } {
  const env = opts.env ?? process.env;
  const bound: WebhookBinding[] = [];
  const unbound: WebhookRef[] = [];
  for (const ref of refs) {
    const fromOption = opts.bindings?.[ref.name];
    const url = fromOption ?? env[webhookEnvVar(ref.name)];
    if (!url) {
      unbound.push(ref);
      continue;
    }
    const urlProblem = webhookUrlProblem(url, opts);
    if (urlProblem) throw new Error(`webhook "${ref.name}": the URL ${urlProblem}`);
    const secret = opts.secrets?.[ref.name] ?? env[webhookSecretEnvVar(ref.name)];
    if (secret !== undefined && secret !== '') {
      try {
        webhookSecretKey(secret);
      } catch (err) {
        throw new Error(`webhook "${ref.name}": the secret ${(err as Error).message}`);
      }
    }
    bound.push({
      name: ref.name,
      url,
      ...(secret ? { secret } : {}),
      source: fromOption !== undefined ? 'option' : 'env',
    });
  }
  return { bound, unbound };
}

/** The progress sink plus `flush()`, which resolves once every POST so far has settled. */
export interface LocalWebhookSink extends EngineProgressSink {
  flush(): Promise<void>;
  /** Deliveries attempted / answered 2xx so far. */
  readonly stats: { attempted: number; delivered: number };
}

/**
 * An EngineProgressSink that implements `event` only: each event from a node
 * whose `webhook` is bound is POSTed, in emission order, one at a time.
 * Never throws (progress sinks must not); every outcome is one log line
 * naming the webhook, never its URL or secret.
 */
export function localWebhookSink(args: {
  /** nodeId -> webhook name (from `webhookRefsOf`). */
  routes: Map<string, string>;
  /** name -> binding (from `resolveWebhookBindings`). */
  bindings: Map<string, WebhookBinding>;
  runId: string;
  deviceId: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  log: (message: string) => void;
}): LocalWebhookSink {
  const doFetch = args.fetch ?? fetch;
  const timeoutMs = args.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const stats = { attempted: 0, delivered: 0 };
  let chain: Promise<void> = Promise.resolve();

  const post = async (binding: WebhookBinding, event: EngineEventRecord): Promise<void> => {
    const envelope = workflowEventEnvelope({ event, runId: args.runId, deviceId: args.deviceId });
    const body = JSON.stringify(envelope);
    const headers = webhookHeaders({
      id: envelope.id,
      timestamp: Math.floor(Date.now() / 1000),
      body,
      type: envelope.type,
      secrets: binding.secret ? [binding.secret] : [],
    });
    const started = Date.now();
    stats.attempted += 1;
    try {
      const res = await doFetch(binding.url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Drain so the socket is released; the body is not used.
      await res.arrayBuffer().catch(() => undefined);
      const ok = res.status >= 200 && res.status < 300;
      if (ok) stats.delivered += 1;
      args.log(
        `webhook "${binding.name}" ${event.kind} from ${event.nodeId}: HTTP ${res.status} in ${Date.now() - started} ms${ok ? '' : ' (not delivered; local delivery does not retry)'}`,
      );
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string } };
      const why = e.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : (e.cause?.code ?? e.name ?? 'error');
      args.log(`webhook "${binding.name}" ${event.kind} from ${event.nodeId}: POST failed (${why}; local delivery does not retry)`);
    }
  };

  return {
    stats,
    runStatus() {},
    step() {},
    event(event) {
      const name = args.routes.get(event.nodeId);
      if (!name) return;
      const binding = args.bindings.get(name);
      if (!binding) return; // unbound: warned once when the run started
      chain = chain.then(() => post(binding, event)).catch(() => undefined);
    },
    flush() {
      return chain;
    },
  };
}
