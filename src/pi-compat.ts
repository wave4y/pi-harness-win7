/**
 * Deliberately narrow Pi AI surface for the Windows 7 build.
 *
 * Pi's main AI barrel eagerly loads modern provider SDKs. The Agent class and
 * agent loop only need these helpers; retain the original implementations and
 * supply our Node 12 HTTP transport through Agent's documented streamFn option.
 * The esbuild resolver maps ONLY the bare @mariozechner/pi-ai import here.
 */
export {
  EventStream,
  AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from '@mariozechner/pi-ai/dist/utils/event-stream.js';
export {
  validateToolArguments,
  validateToolCall,
} from '@mariozechner/pi-ai/dist/utils/validation.js';
export { getModel } from '@mariozechner/pi-ai/dist/models.js';
export { parseStreamingJson } from '@mariozechner/pi-ai/dist/utils/json-parse.js';

export function streamSimple(): never {
  throw new Error('This Windows 7 build requires the configured custom streamFn transport.');
}
