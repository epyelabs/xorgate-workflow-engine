import type { WorkflowDefinition } from './schemas/workflows';
import { coreCatalog } from './catalog/index';
import type { Catalog } from './catalog/pack';
import { validateDefinitionForPublish, type ValidationIssue } from './validate';
import { inspectTemplate as inspectDefinition, parseTemplate } from './local/manifest-builder';

/**
 * The template-level helpers the docs promise from the package root. Both
 * accept what `xwe` accepts on the command line: a bare definition or an API
 * snapshot wrapping one, v1 or v2 (v1 is upgraded).
 */

/** A template that is not a definition at all reports one `INVALID_DEFINITION` issue. */
export type ValidateDefinitionIssue =
  | ValidationIssue
  | { code: 'INVALID_DEFINITION'; message: string; nodeId?: undefined; edgeId?: undefined; portId?: undefined };

export interface ValidateDefinitionResult {
  ok: boolean;
  issues: ValidateDefinitionIssue[];
  /** The upgraded (v2) definition, when the template parsed at all. */
  definition?: WorkflowDefinition;
}

/** The same publish validation the platform's editor runs. Never throws. `catalog` defaults to the core catalog. */
export function validateDefinition(template: unknown, catalog: Catalog = coreCatalog): ValidateDefinitionResult {
  let definition: WorkflowDefinition;
  try {
    definition = parseTemplate(template);
  } catch (err) {
    return {
      ok: false,
      issues: [{ code: 'INVALID_DEFINITION', message: err instanceof Error ? err.message : String(err) }],
    };
  }
  const { issues } = validateDefinitionForPublish(definition, catalog);
  return { ok: issues.length === 0, issues, definition };
}

export interface TemplateInput {
  /** The `--input` key: `video`, `telemetry`, or the node id when ambiguous. */
  key: string;
  nodeId: string;
  type: string;
  label: string;
}

export interface InspectTemplateResult {
  definition: WorkflowDefinition;
  issues: ValidationIssue[];
  /** Source nodes a run must bind, with the key each one answers to. */
  inputs: TemplateInput[];
  /** Capability tokens across the graph: `secret:<name>`, `video`, `metric:<name>`. */
  requires: string[];
}

/** What a run of this template would need; the report `xwe validate` prints. Throws when the template does not parse. `catalog` defaults to the core catalog. */
export function inspectTemplate(template: unknown, catalog: Catalog = coreCatalog): InspectTemplateResult {
  const info = inspectDefinition(parseTemplate(template), catalog);
  return {
    definition: info.definition,
    issues: info.issues,
    inputs: info.sources.map((s) => ({ key: s.inputKey, nodeId: s.nodeId, type: s.type, label: s.label })),
    requires: info.requires,
  };
}
