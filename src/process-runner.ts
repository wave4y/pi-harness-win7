import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { cleanProcessEnvironment } from './process-env';

export interface CancellationSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: any): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}


const MAX_OUTPUT_BYTES = 64 * 1024;

// Callers validate and resolve the executable/cwd and enforce their policy.
export async function executeProcess(executable: string, argv: string[], cwd: string, timeoutMs: number, signal?: CancellationSignal, onUpdate?: (value: any) => void) {
  if (signal && signal.aborted) throw new Error('Operation cancelled.');
  const childEnvironment = cleanProcessEnvironment();
  return new Promise<any>((resolve, reject) => {
    const child = spawn(executable, argv, { cwd, env: childEnvironment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', received = 0, timedOut = false, cancelled = false, truncated = false, done = false, terminationRequested = false;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let forceTimer: any;
    const cancellationNote = 'Cancellation terminates only the direct child; descendant processes are not guaranteed to stop. The executable allowlist is not a filesystem sandbox.';
    const cleanup = () => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (signal) signal.removeEventListener('abort', abort);
    };
    const finish = (exitCode: number | null, exitSignal: string | null, childExited: boolean) => {
      if (done) return;
      done = true;
      cleanup();
      stdout += decoders.stdout.end();
      stderr += decoders.stderr.end();
      resolve({ executable, args: argv, cwd, stdout, stderr, exitCode, signal: exitSignal, timedOut, cancelled, truncated, terminationRequested, childExited, cancellationNote });
    };
    const stop = () => {
      if (terminationRequested || done) return;
      terminationRequested = true;
      try { child.kill('SIGKILL'); } catch (_) { /* Report whether exit was observed below. */ }
      // Descendants can retain inherited pipes after the direct child exits.
      forceTimer = setTimeout(() => {
        if (child.stdout) child.stdout.destroy();
        if (child.stderr) child.stderr.destroy();
        finish(child.exitCode, child.signalCode, child.exitCode !== null || child.signalCode !== null);
      }, 1000);
    };
    const abort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (done) return;
      const remaining = MAX_OUTPUT_BYTES - received;
      const kept = chunk.slice(0, Math.max(0, remaining));
      received += kept.length;
      const text = decoders[stream].write(kept);
      if (stream === 'stdout') stdout += text; else stderr += text;
      if (text && onUpdate) {
        try { onUpdate({ content: [{ type: 'text', text }], details: { stream } }); }
        catch (error) {
          // An observer failure must not throw from an EventEmitter and crash the server.
          stop();
          done = true;
          cleanup();
          if (child.stdout) child.stdout.destroy();
          if (child.stderr) child.stderr.destroy();
          reject(error);
          return;
        }
      }
      if (chunk.length > remaining) { truncated = true; stop(); }
    };
    child.stdout!.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr!.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.on('error', error => {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    });
    child.on('close', (code, exitSignal) => finish(code, exitSignal, true));
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
  });
}
