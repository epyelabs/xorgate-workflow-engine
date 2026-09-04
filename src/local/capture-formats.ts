import type { WorkflowDefinition } from '../schemas/workflows';

/**
 * Each output.data_capture node's configured artifact format. Pure mirror of
 * captureFormats() in core-service's engine/target.ts (which stayed behind
 * with the AWS wiring).
 */
export function captureFormatsOf(definition: WorkflowDefinition): Record<string, 'jsonl' | 'json'> {
  const formats: Record<string, 'jsonl' | 'json'> = {};
  for (const node of definition.nodes) {
    if (node.type === 'output.data_capture') {
      formats[node.id] = node.data.config?.format === 'json' ? 'json' : 'jsonl';
    }
  }
  return formats;
}
