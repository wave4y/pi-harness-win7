import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CancellationSignal, executeProcess } from './process-runner';

// Fixed product runtime, never discovered through PATH, registry, a user home,
// or model-supplied executable/environment fields. Node 12 compatible.
const realpath = fs.realpathSync.native || fs.realpathSync;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const cache = new Map<string, { fingerprint: string; status: PythonRuntimeStatus }>();
const REQUIRED_PACKAGES = ['requests', 'urllib3', 'charset-normalizer', 'idna', 'certifi', 'numpy', 'pandas', 'python-dateutil', 'six', 'pytz', 'tzdata', 'python-docx', 'python-pptx', 'lxml', 'pillow', 'xlsxwriter', 'openpyxl', 'et-xmlfile', 'typing-extensions', 'defusedxml'];

export interface PythonRuntimeStatus {
  runtimeDir: string;
  executable: string;
  available: boolean;
  ready: boolean;
  state: 'missing' | 'invalid' | 'not-tested' | 'ready' | 'error';
  reason?: string;
  version?: string;
  architecture?: string;
  packages: Array<{ name: string; version: string }>;
  checkedAt?: string;
  probe?: any;
  diagnostics?: { exitCode: number | null; stderr: string; timedOut: boolean; cancelled: boolean; truncated: boolean };
  win7Validated: boolean;
}

export interface PythonRunArguments { script: string; args?: string[]; cwd?: string; timeoutMs?: number; }
export interface PythonPathOptions { allowOutsideWorkspace?: boolean; }

function inside(root: string, candidate: string) {
  const normalize = (text: string) => process.platform === 'win32' ? text.toLowerCase() : text;
  const relative = path.relative(normalize(root), normalize(candidate));
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function readSmallFile(filename: string): Buffer {
  const descriptor = fs.openSync(filename, 'r');
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) throw new Error('Python runtime metadata is not a bounded regular file.');
    const buffer = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const length = fs.readSync(descriptor, buffer, count, buffer.length - count, null);
      if (!length) break;
      count += length;
    }
    if (count !== stat.size) throw new Error('Python runtime metadata changed while reading.');
    return buffer.slice(0, count);
  } finally { fs.closeSync(descriptor); }
}

function fixedFile(root: string, name: string) {
  const filename = realpath(path.join(root, name));
  if (!inside(root, filename) || !fs.statSync(filename).isFile()) throw new Error('Python runtime file is outside its directory or is not a regular file.');
  return filename;
}

function fileHash(filename: string): string {
  const stat = fs.statSync(filename);
  // python.exe and the trusted probe are small; do not allocate arbitrary files.
  if (stat.size > 16 * 1024 * 1024) throw new Error('Python runtime executable or probe exceeds its size limit.');
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function packageName(name: string) { return name.toLowerCase().replace(/[_.]+/g, '-'); }

function inspectRuntime(runtimeDir: string) {
  if (typeof runtimeDir !== 'string' || !path.isAbsolute(runtimeDir)) throw new Error('Python runtime directory must be an absolute path.');
  const root = realpath(runtimeDir);
  if (!fs.statSync(root).isDirectory()) throw new Error('Python runtime path is not a directory.');
  const executable = fixedFile(root, 'python.exe');
  const script = fixedFile(root, 'runtime-probe.py');
  const manifestPath = fixedFile(root, 'runtime-manifest.json');
  const pathConfig = fixedFile(root, 'python38._pth');
  const manifest = JSON.parse(readSmallFile(manifestPath).toString('utf8'));
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.python || manifest.python.version !== '3.8.10' || manifest.python.architecture !== 'x64' || manifest.python.executable !== 'python.exe') throw new Error('Unsupported Python runtime manifest.');
  if (!manifest.probe || manifest.probe.script !== 'runtime-probe.py' || !/^[a-f0-9]{64}$/i.test(manifest.probe.sha256 || '') || !/^[a-f0-9]{64}$/i.test(manifest.python.sha256 || '')) throw new Error('Python runtime executable/probe hashes are missing.');
  if (fileHash(executable) !== manifest.python.sha256.toLowerCase() || fileHash(script) !== manifest.probe.sha256.toLowerCase()) throw new Error('Python runtime executable/probe integrity check failed.');
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== REQUIRED_PACKAGES.length) throw new Error('Python runtime package manifest is incomplete.');
  const packages = manifest.packages.map((entry: any) => {
    if (!entry || typeof entry.name !== 'string' || typeof entry.version !== 'string' || !entry.version || entry.version.length > 64) throw new Error('Invalid Python runtime package metadata.');
    return { name: packageName(entry.name), version: entry.version };
  });
  if (new Set(packages.map((entry: any) => entry.name)).size !== REQUIRED_PACKAGES.length || REQUIRED_PACKAGES.some(name => !packages.some((entry: any) => entry.name === name))) throw new Error('Python runtime package manifest is incomplete.');
  const fingerprint = [executable, script, manifestPath, pathConfig].map(filename => {
    const stat = fs.statSync(filename);
    return filename + ':' + stat.size + ':' + stat.mtimeMs + ':' + stat.ctimeMs;
  }).join('|');
  const status: PythonRuntimeStatus = { runtimeDir: root, executable, available: true, ready: false, state: 'not-tested', version: manifest.python.version, architecture: manifest.python.architecture, packages, win7Validated: false };
  return { root, executable, script, manifest, fingerprint, status };
}

function failedStatus(runtimeDir: string, error: any): PythonRuntimeStatus {
  const location = typeof runtimeDir === 'string' ? path.resolve(runtimeDir) : '';
  const missing = error && error.code === 'ENOENT';
  return { runtimeDir: location, executable: path.join(location, 'python.exe'), available: false, ready: false, state: missing ? 'missing' : 'invalid', reason: missing ? 'Bundled Python runtime files are missing.' : String(error && error.message || 'Invalid Python runtime.').slice(0, 500), packages: [], win7Validated: false };
}

export function getPythonRuntimeStatus(runtimeDir: string): PythonRuntimeStatus {
  try {
    const inspected = inspectRuntime(runtimeDir);
    const previous = cache.get(inspected.root);
    return previous && previous.fingerprint === inspected.fingerprint ? previous.status : inspected.status;
  } catch (error) { return failedStatus(runtimeDir, error); }
}

export async function probePythonRuntime(runtimeDir: string, options: { signal?: CancellationSignal } = {}): Promise<PythonRuntimeStatus> {
  if (options.signal && options.signal.aborted) throw new Error('Operation cancelled.');
  let inspected: ReturnType<typeof inspectRuntime>;
  try { inspected = inspectRuntime(runtimeDir); }
  catch (error) { return failedStatus(runtimeDir, error); }
  const status = { ...inspected.status, checkedAt: new Date().toISOString() };
  try {
    const output = await executeProcess(inspected.executable, ['-I', '-X', 'utf8', '-u', '-B', inspected.script], inspected.root, 30000, options.signal);
    status.diagnostics = { exitCode: output.exitCode, stderr: output.stderr.slice(0, 4000), timedOut: output.timedOut, cancelled: output.cancelled, truncated: output.truncated };
    if (output.cancelled) throw new Error('Python runtime probe was cancelled.');
    if (output.timedOut) throw new Error('Python runtime probe timed out.');
    if (output.truncated) throw new Error('Python runtime probe exceeded its output limit.');
    let report: any;
    try { report = JSON.parse(output.stdout); } catch (_) { throw new Error('Python runtime probe did not return valid JSON.'); }
    // Preserve structured import failures for Win7 DLL diagnostics, even when
    // the trusted probe reports exit 1. Never expose arbitrary stderr here.
    if (report && typeof report === 'object' && !Array.isArray(report)) status.probe = report;
    if (output.exitCode !== 0) throw new Error('Python runtime probe failed (exit ' + output.exitCode + '). Check the required Windows updates, runtime libraries and package imports.');
    if (!report || report.ok !== true || !report.python || report.python.version !== '3.8.10' || report.python.bits !== 64 || report.python.isolated !== true || report.python.utf8Mode !== true) throw new Error('Python runtime interpreter/isolation checks did not pass.');
    if (!Array.isArray(report.modules) || report.modules.length !== inspected.status.packages.length || !Array.isArray(report.checks) || !report.checks.length || report.checks.some((check: any) => !check || check.ok !== true)) throw new Error('Python runtime import/platform checks did not pass.');
    const modules = new Map<string, any>();
    for (const item of report.modules) {
      if (!item || typeof item.distribution !== 'string' || item.ok !== true || typeof item.name !== 'string') throw new Error('Python runtime package import failed.');
      const name = packageName(item.distribution);
      if (modules.has(name)) throw new Error('Python runtime probe reported duplicate packages.');
      modules.set(name, item);
    }
    for (const entry of inspected.status.packages) {
      const imported = modules.get(entry.name);
      if (!imported || imported.version !== entry.version) throw new Error('Python runtime package version/import checks did not pass.');
    }
    status.ready = true;
    status.state = 'ready';
  } catch (error) {
    status.ready = false;
    status.state = 'error';
    status.reason = String((error as any).message || 'Python runtime probe failed.').slice(0, 500);
  }
  // A runtime relocated or replaced while the child ran must be probed again.
  try { if (inspectRuntime(runtimeDir).fingerprint !== inspected.fingerprint) throw new Error('Python runtime changed during its probe.'); }
  catch (_) { status.ready = false; status.state = 'error'; status.reason = 'Python runtime changed during its probe.'; }
  cache.set(inspected.root, { fingerprint: inspected.fingerprint, status });
  return status;
}

function resolveLocalPath(root: string, input: string, allowOutside: boolean) {
  if (typeof input !== 'string' || !input || input.length > 4096 || /[\x00-\x1f<>"|?*]/.test(input)) throw new Error('Invalid Python script or working directory path.');
  if (/^[\\/]{2}/.test(input) || /^[a-z]:(?:$|[^\\/])/i.test(input)) throw new Error('Unsupported Python path.');
  const portable = input.replace(/\\/g, path.sep);
  const withoutDrive = process.platform === 'win32' ? portable.replace(/^[a-z]:/i, '') : portable;
  if (withoutDrive.indexOf(':') !== -1) throw new Error('Alternate data streams are not supported.');
  for (const part of withoutDrive.split(/[\\/]/)) {
    if (!part || part === '.' || part === '..') continue;
    if (/[. ]$/.test(part) || /^(con|conin\$|conout\$|clock\$|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(part)) throw new Error('Reserved or ambiguous Windows file name.');
  }
  const target = path.resolve(root, portable);
  if (!allowOutside && !inside(root, target)) throw new Error('Python path is outside the workspace.');
  const resolved = realpath(target);
  if (!allowOutside && !inside(root, resolved)) throw new Error('Python symbolic link points outside the workspace.');
  return resolved;
}

export function preparePythonRun(runtimeDir: string, workspace: string, args: PythonRunArguments, options: PythonPathOptions = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['script', 'args', 'cwd', 'timeoutMs'].includes(key))) throw new Error('run_python accepts only script, args, cwd and timeoutMs; executable, code and environment overrides are disabled.');
  const inspected = inspectRuntime(runtimeDir);
  const root = realpath(workspace);
  if (!fs.statSync(root).isDirectory()) throw new Error('Workspace must be an existing directory.');
  const script = resolveLocalPath(root, args.script, !!options.allowOutsideWorkspace);
  if (!fs.statSync(script).isFile()) throw new Error('Python script must be an existing regular file.');
  const cwd = resolveLocalPath(root, args.cwd === undefined ? '.' : args.cwd, !!options.allowOutsideWorkspace);
  if (!fs.statSync(cwd).isDirectory()) throw new Error('Python working directory must be an existing directory.');
  const argv = args.args === undefined ? [] : args.args;
  if (!Array.isArray(argv) || argv.length > 250 || argv.some(value => typeof value !== 'string' || value.length > 32768 || value.indexOf('\0') !== -1)) throw new Error('Python args must contain at most 250 valid literal strings.');
  const timeoutMs = args.timeoutMs === undefined ? 30000 : args.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error('Python timeoutMs must be an integer between 100 and 120000.');
  return { executable: inspected.executable, script, cwd, args: ['-I', '-X', 'utf8', '-u', '-B', script, ...argv], timeoutMs };
}

export async function runPython(runtimeDir: string, workspace: string, args: PythonRunArguments, options: PythonPathOptions = {}, signal?: CancellationSignal, onUpdate?: (value: any) => void) {
  if (signal && signal.aborted) throw new Error('Operation cancelled.');
  const plan = preparePythonRun(runtimeDir, workspace, args, options);
  let status = getPythonRuntimeStatus(runtimeDir);
  if (!status.ready) status = await probePythonRuntime(runtimeDir, { signal });
  if (signal && signal.aborted) throw new Error('Operation cancelled.');
  if (!status.ready) throw new Error(status.reason || 'Bundled Python is not ready; run the Python status check.');
  const latest = preparePythonRun(runtimeDir, workspace, args, options);
  if (JSON.stringify(latest) !== JSON.stringify(plan)) throw new Error('Python script/interpreter paths changed before execution; request approval again.');
  return { ...await executeProcess(plan.executable, plan.args, plan.cwd, plan.timeoutMs, signal, onUpdate), script: plan.script };
}
