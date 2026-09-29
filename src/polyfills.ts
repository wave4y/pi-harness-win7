import AbortControllerPolyfill, { AbortSignal as AbortSignalPolyfill } from 'abort-controller';
import { deserialize, serialize } from 'v8';

/** Install only missing globals required by Pi on the pinned Node 12 runtime. */
export function installPolyfills(): void {
  const globals = globalThis as any;
  if (typeof globals.AbortController === 'undefined') {
    globals.AbortController = AbortControllerPolyfill;
  }
  if (typeof globals.AbortSignal === 'undefined') {
    globals.AbortSignal = AbortSignalPolyfill;
  }
  if (typeof globals.structuredClone === 'undefined') {
    // Pi clones JSON tool arguments. v8 serialization also preserves cycles,
    // buffers and dates without the lossy JSON stringify/parse shortcut.
    globals.structuredClone = (value: unknown) => deserialize(serialize(value));
  }
}

installPolyfills();
