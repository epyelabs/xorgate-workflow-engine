import { z } from 'zod';

/**
 * Server-side validation for the Workflows feature. These MIRROR the frontend Zod
 * (xorgate-web/src/lib/workflow-schemas.ts, device-workflow-schemas.ts,
 * workflow-run-schemas.ts) — the shapes are the API contract. jsonb columns
 * (definition, triggers, triggerContext) are validated with these before they hit
 * the DB, and again when re-read into an executor.
 */

// --- Graph definition (react-flow native) ------------------------------------
export const workflowNodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.object({
    label: z.string(),
    config: z.record(z.string(), z.unknown()).default({}),
  }),
});

export const workflowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().nullish(),
  targetHandle: z.string().nullish(),
});

export const workflowDefinitionSchema = z.object({
  // Absent = v1 (PoC node types). v2 = catalog node types; see
  // src/workflows/compat.ts (upgradeDefinition) and the catalog registry.
  schemaVersion: z.number().int().positive().optional(),
  nodes: z.array(workflowNodeSchema),
  edges: z.array(workflowEdgeSchema),
});

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

// --- Template create / update inputs -----------------------------------------
export const createWorkflowTemplateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80, 'Name is too long'),
  description: z.string().max(280, 'Description is too long').optional(),
});

export const updateWorkflowTemplateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(280).nullable().optional(),
});

export const saveDraftSchema = z.object({
  definition: workflowDefinitionSchema,
  message: z.string().max(280).optional(),
});

// --- Attachment triggers (device_workflows) ----------------------------------
export const conditionOperatorSchema = z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']);

export const telemetryConditionSchema = z.object({
  metric: z.string().min(1),
  operator: conditionOperatorSchema,
  value: z.number(),
});

export const contextWindowSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('sinceLastRun') }),
  z.object({ mode: z.literal('range'), from: z.string().min(1), to: z.string().min(1) }),
  z.object({ mode: z.literal('lastN'), n: z.number().int().positive() }),
]);

export const attachmentTriggerSchema = z.discriminatedUnion('type', [
  // Device-recorded media session closed by the sweeper (offline recording
  // plan, Phase 6.4). AT-LEAST-ONCE: close is advisory and reversible — a
  // straggler segment reopens the session and the next sweep re-closes it,
  // firing this trigger AGAIN with updated rollups. Workflows that care must
  // dedupe on sessionId (the trigger-state/run-history pattern).
  //
  // This is the BATCH half of the media trigger pair (destroy-kvs-recorder
  // decision L): one run over the whole session, minutes after the last chunk.
  z.object({
    type: z.literal('session_completed'),
    streamKeys: z.array(z.string()).min(1),
  }),
  // The NEAR-REALTIME half: one run per ~60 s chunk, fired from
  // media-segment-ingest as each segment lands. Resolution is the N=1 case of
  // the session binding (one-element `segments[]`), so it shares the whole
  // media path with session_completed.
  //
  // ⚠️ No freshness gate and no burst throttling (decision K, prototyping): a
  // device back from hours offline uploads a flood of chunks and fires one run
  // each. Carried as known debt in README §10.
  z.object({
    type: z.literal('segment_uploaded'),
    streamKeys: z.array(z.string()).min(1),
  }),
  z.object({
    type: z.literal('schedule'),
    cron: z.string().min(1),
    telemetryContext: contextWindowSchema,
    mediaContext: contextWindowSchema,
    // Backend-only dedupe knob, not surfaced in the FE editor.
    cooldownSeconds: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('telemetry_condition'),
    combinator: z.enum(['and', 'or']),
    conditions: z.array(telemetryConditionSchema).min(1),
    // Backend-only override; default 300s (see workflow-triggers.ts).
    cooldownSeconds: z.number().int().positive().optional(),
  }),
]);

export const attachWorkflowSchema = z.object({
  templateId: z.string().min(1),
  pinnedVersion: z.number().int().positive().nullable(),
  triggers: z.array(attachmentTriggerSchema).min(1),
});

export type ConditionOperator = z.infer<typeof conditionOperatorSchema>;
export type TelemetryCondition = z.infer<typeof telemetryConditionSchema>;
export type ContextWindow = z.infer<typeof contextWindowSchema>;
export type AttachmentTrigger = z.infer<typeof attachmentTriggerSchema>;

// --- Manual "Run now" context (device-workflows.ts) --------------------------
export const manualWindowSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('range'), from: z.string().min(1), to: z.string().min(1) }),
  z.object({ mode: z.literal('lastN'), n: z.number().int().positive() }),
]);

// Media selection for a scheduled/manual run: hand-picked on-device sessions,
// or the most recent N. (Was `recordings`/`lastN` against the cloud recorder's
// table; redesigned rather than retrofitted per decision K.)
export const scheduleRunSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('sessions'), sessionIds: z.array(z.string()).min(1) }),
  z.object({ mode: z.literal('lastNSessions'), n: z.number().int().positive() }),
]);

export const manualRunContextSchema = z.discriminatedUnion('triggerType', [
  // Run a session-triggered workflow by hand over one chosen session.
  z.object({ triggerType: z.literal('session_completed'), sessionId: z.string().min(1) }),
  // …and the chunk trigger over one segment of it. `seq` omitted = the
  // session's newest segment (the chunk that would have fired most recently).
  z.object({
    triggerType: z.literal('segment_uploaded'),
    sessionId: z.string().min(1),
    seq: z.number().int().nonnegative().optional(),
  }),
  z.object({ triggerType: z.literal('schedule'), selection: scheduleRunSelectionSchema }),
  z.object({ triggerType: z.literal('telemetry_condition'), window: manualWindowSchema }),
]);

export type ManualRunContext = z.infer<typeof manualRunContextSchema>;
