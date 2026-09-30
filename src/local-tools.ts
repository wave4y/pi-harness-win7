import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { executeProcess, CancellationSignal } from './process-runner';
import { preparePythonRun, runPython } from './python-runtime';
export { CancellationSignal } from './process-runner';

// Keep this module compatible with Node 12 (the last official Win7 Node line).
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SCAN_FILES = 3000;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.npm-cache', '.state', '.runtime', 'release', 'dist']);
const SHELL_NAMES = new Set(['cmd', 'command', 'powershell', 'pwsh', 'wscript', 'cscript', 'mshta', 'bash', 'sh', 'zsh', 'fish']);
// Native Windows resolution does not require enumerating every ancestor of a
// permitted directory, unlike the JavaScript fallback in older Node releases.
const realpath = fs.realpathSync.native || fs.realpathSync;

export interface LocalToolOptions { allowedExecutables?: string[]; allowOutsideWorkspace?: boolean; allowAnyExecutable?: boolean; pythonRuntimeDir?: string; }

function assertNotAborted(signal?: CancellationSignal): void {
  if (signal && signal.aborted) throw new Error('Operation cancelled.');
}

function normalizeCase(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(normalizeCase(root), normalizeCase(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function workspaceRoot(workspace: string): string {
  const root = realpath(workspace);
  if (!fs.statSync(root).isDirectory()) throw new Error('Workspace must be an existing directory.');
  return root;
}

function safePath(root: string, input: string, allowOutside = false): string {
  if (typeof input !== 'string' || input.length > 4096 || /[\x00-\x1f<>"|?*]/.test(input)) {
    throw new Error('Invalid file path.');
  }
  const portable = input.replace(/\\/g, path.sep);
  // Reject Win32 device namespaces, UNC paths and drive-relative paths.
  if (/^[\\/]{2}/.test(input) || /^[a-z]:(?:$|[^\\/])/i.test(input)) throw new Error('Unsupported file path.');
  const withoutDrive = process.platform === 'win32' ? portable.replace(/^[a-z]:/i, '') : portable;
  if (withoutDrive.indexOf(':') !== -1) throw new Error('Alternate data streams are not supported.');
  for (const segment of withoutDrive.split(/[\\/]/)) {
    if (!segment || segment === '.' || segment === '..') continue;
    if (/[. ]$/.test(segment) || /^(con|conin\$|conout\$|clock\$|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(segment)) {
      throw new Error('Reserved or ambiguous Windows file name.');
    }
  }
  const target = path.resolve(root, portable || '.');
  if (!allowOutside && !isInside(root, target)) throw new Error('Path is outside the workspace.');
  return target;
}

function existingPath(root: string, input: string, allowOutside = false): string {
  const target = safePath(root, input, allowOutside);
  const real = realpath(target);
  if (!allowOutside && !isInside(root, real)) throw new Error('Symbolic link points outside the workspace.');
  return real;
}

function relativePath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/') || '.';
}

function writablePath(root: string, input: string, allowOutside = false): string {
  const target = safePath(root, input, allowOutside);
  if (target === root) throw new Error('Cannot write to the workspace directory.');
  const boundary = allowOutside ? path.parse(target).root : root;
  const segments = path.relative(boundary, target).split(path.sep);
  let current = boundary;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if ((error as any).code === 'ENOENT' && i === segments.length - 1) break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('Writing through symbolic links or junctions is not allowed.');
    if (i < segments.length - 1 && !stat.isDirectory()) throw new Error('Parent path is not a directory.');
    if (i === segments.length - 1 && !stat.isFile()) throw new Error('Target is not a regular file.');
  }
  const parentReal = realpath(path.dirname(target));
  if (!allowOutside && !isInside(root, parentReal)) throw new Error('Parent directory is outside the workspace.');
  return target;
}

function decodeText(buffer: Buffer): string {
  if (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) {
    throw new Error('UTF-16 files are not supported; convert this file to UTF-8 before editing.');
  }
  if (buffer.indexOf(0) !== -1) throw new Error('Binary files are not supported.');
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) throw new Error('File is not valid UTF-8; automatic encoding conversion is disabled.');
  return text;
}

function readBoundedText(target: string): { content: string; bytes: number } {
  const fd = fs.openSync(target, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('Target is not a regular file.');
    if (stat.size > MAX_FILE_BYTES) throw new Error('File exceeds the 1 MiB text limit.');
    // Bound allocation and reads even if another process grows the file concurrently.
    const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES + 1, stat.size + 1));
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count > MAX_FILE_BYTES) throw new Error('File exceeds the 1 MiB text limit.');
    if (count > stat.size) throw new Error('File grew while being read; retry after the writer finishes.');
    return { content: decodeText(buffer.slice(0, count)), bytes: count };
  } finally { fs.closeSync(fd); }
}

export function listDirectory(workspace: string, input: string = '.', allowOutside = false) {
  const root = workspaceRoot(workspace);
  const target = existingPath(root, input, allowOutside);
  if (!fs.statSync(target).isDirectory()) throw new Error('Target is not a directory.');
  const names = fs.readdirSync(target).sort();
  const entries = names.slice(0, 1000).map(name => {
    const child = path.join(target, name);
    const stat = fs.lstatSync(child);
    return { name, path: relativePath(root, child), type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', size: stat.size };
  });
  return { path: relativePath(root, target), entries, truncated: names.length > entries.length };
}

export function readTextFile(workspace: string, input: string, allowOutside = false) {
  const root = workspaceRoot(workspace);
  const target = existingPath(root, input, allowOutside);
  return { path: relativePath(root, target), ...readBoundedText(target) };
}

export function writeTextFile(workspace: string, input: string, content: string, allowOutside = false) {
  if (typeof content !== 'string') throw new Error('File content must be a string.');
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('File exceeds the 1 MiB text limit.');
  if (buffer.indexOf(0) !== -1 || buffer.toString('utf8') !== content) throw new Error('Content must be valid UTF-8 text without NUL characters.');
  const root = workspaceRoot(workspace);
  const target = writablePath(root, input, allowOutside);
  let mode = 0o600;
  if (fs.existsSync(target)) {
    // Do not silently overwrite a binary / legacy-encoded file with UTF-8.
    readBoundedText(target);
    mode = fs.statSync(target).mode;
  }
  const temporary = path.join(path.dirname(target), '.agent-write-' + crypto.randomBytes(12).toString('hex') + '.tmp');
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    writablePath(root, input, allowOutside);
    fs.renameSync(temporary, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if ((error as any).code !== 'ENOENT') throw error; }
  }
  return { path: relativePath(root, target), bytes: buffer.length };
}

export function createDirectory(workspace: string, input: string, allowOutside = false) {
  const root = workspaceRoot(workspace);
  const target = safePath(root, input, allowOutside);
  const boundary = allowOutside ? path.parse(target).root : root;
  const relative = path.relative(boundary, target);
  const created: string[] = [];
  let current = boundary;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    let stat: fs.Stats | undefined;
    try { stat = fs.lstatSync(current); }
    catch (error) { if ((error as any).code !== 'ENOENT') throw error; }
    if (!stat) {
      try { fs.mkdirSync(current, 0o700); created.push(relativePath(root, current)); }
      catch (error) { if ((error as any).code !== 'EEXIST') throw error; }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink()) throw new Error('Creating directories through symbolic links or junctions is not allowed.');
    if (!stat.isDirectory()) throw new Error('Path component is not a directory.');
    if (!allowOutside && !isInside(root, realpath(current))) throw new Error('Directory is outside the workspace.');
  }
  return { path: relativePath(root, target), created };
}

function integer(value: any, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error('Numeric argument is outside its allowed range.');
  return value;
}

async function searchFiles(workspace: string, args: any, signal?: CancellationSignal, allowOutside = false) {
  if (typeof args.query !== 'string' || args.query.length === 0 || args.query.length > 1000) throw new Error('A non-empty search query of at most 1000 characters is required.');
  const root = workspaceRoot(workspace);
  const start = existingPath(root, args.path || '.', allowOutside);
  if (!fs.statSync(start).isDirectory()) throw new Error('Search path must be a directory.');
  const limit = integer(args.maxResults, 100, 1, 300);
  const query = args.caseSensitive ? args.query : args.query.toLowerCase();
  const matches: Array<{ path: string; line: number; text: string }> = [];
  const directories = [{ target: start, depth: 0 }];
  let scannedFiles = 0, scannedBytes = 0, skippedFiles = 0, visitedDirectories = 0, truncated = false;
  while (directories.length) {
    assertNotAborted(signal);
    const directory = directories.pop()!;
    if (++visitedDirectories > 2000) { truncated = true; break; }
    const names = fs.readdirSync(directory.target).sort();
    for (const name of names) {
      assertNotAborted(signal);
      const target = path.join(directory.target, name);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(target); } catch (_) { skippedFiles++; continue; }
      if (stat.isSymbolicLink()) { skippedFiles++; continue; }
      if (stat.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(name)) {
          if (directory.depth >= 12) truncated = true;
          else directories.push({ target, depth: directory.depth + 1 });
        }
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) { skippedFiles++; continue; }
      if (scannedFiles >= MAX_SCAN_FILES || scannedBytes + stat.size > MAX_SCAN_BYTES) { truncated = true; directories.length = 0; break; }
      scannedFiles++;
      let file: { content: string; bytes: number };
      try { file = readBoundedText(existingPath(root, relativePath(root, target), allowOutside)); }
      catch (_) { skippedFiles++; continue; }
      scannedBytes += file.bytes;
      const lines = file.content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const haystack = args.caseSensitive ? lines[index] : lines[index].toLowerCase();
        const found = haystack.indexOf(query);
        if (found === -1) continue;
        const offset = Math.max(0, found - 120);
        matches.push({ path: relativePath(root, target), line: index + 1, text: (offset ? '…' : '') + lines[index].slice(offset, offset + 400) + (lines[index].length > offset + 400 ? '…' : '') });
        if (matches.length >= limit) { truncated = true; break; }
      }
      if (matches.length >= limit) { directories.length = 0; break; }
      // Give cancellation and HTTP handling a chance to run during a large scan.
      if (scannedFiles % 25 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  return { matches, scannedFiles, scannedBytes, skippedFiles, truncated };
}

function executablePath(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Executable must be an absolute path.');
  const resolved = realpath(value);
  if (!fs.statSync(resolved).isFile()) throw new Error('Executable is not a regular file.');
  const basename = path.basename(resolved).toLowerCase().replace(/\.[^.]+$/, '');
  if (SHELL_NAMES.has(basename)) throw new Error('Shell executables are disabled.');
  if (process.platform === 'win32' && path.extname(resolved).toLowerCase() !== '.exe') throw new Error('Only .exe programs can run on Windows. Batch and shell scripts are disabled.');
  return resolved;
}

async function runProcess(workspace: string, options: LocalToolOptions, args: any, signal?: CancellationSignal, onUpdate?: (value: any) => void) {
  assertNotAborted(signal);
  if (!options.allowAnyExecutable && (!options.allowedExecutables || options.allowedExecutables.length === 0)) throw new Error('Program execution is disabled. Configure explicit absolute executable paths to enable it.');
  const executable = executablePath(args.executable);
  const allowlist = (options.allowedExecutables || []).map(executablePath).map(normalizeCase);
  if (!options.allowAnyExecutable && allowlist.indexOf(normalizeCase(executable)) === -1) throw new Error('Executable is not in the configured allowlist.');
  const argv = args.args === undefined ? [] : args.args;
  if (!Array.isArray(argv) || argv.length > 256 || argv.some(value => typeof value !== 'string' || value.length > 32768 || value.indexOf('\0') !== -1)) throw new Error('args must be an array of at most 256 valid strings.');
  const root = workspaceRoot(workspace);
  const cwd = existingPath(root, args.cwd || '.', options.allowOutsideWorkspace);
  if (!fs.statSync(cwd).isDirectory()) throw new Error('Working directory is not a directory.');
  const timeoutMs = integer(args.timeoutMs, 30000, 100, 120000);
  const output = await executeProcess(executable, argv, cwd, timeoutMs, signal, onUpdate);
  return { ...output, cwd: relativePath(root, cwd) };
}

function schema(properties: any, required: string[]) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function result(details: any) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(details, null, 2) }], details };
}

function processResult(details: any) {
  return { ...result(details), isError: details.exitCode !== 0 || details.timedOut || details.cancelled || details.truncated || !details.childExited };
}

export function createLocalTools(workspace: string, options: LocalToolOptions = {}) {
  const root = workspaceRoot(workspace);
  const string = { type: 'string' };
  return [
    {
      name: 'create_directory', label: 'Create directory', description: 'Create a directory and any missing parent directories. Existing directories are accepted. Refuses symbolic links and junctions.',
      parameters: schema({ path: string }, ['path']),
      async execute(_id: string, args: any, signal?: CancellationSignal) { assertNotAborted(signal); return result(createDirectory(root, args.path, options.allowOutsideWorkspace)); }
    },
    {
      name: 'list_directory', label: 'List directory', description: 'List up to 1000 entries in a directory. Paths are relative to the workspace.',
      parameters: schema({ path: string }, []),
      async execute(_id: string, args: any, signal?: CancellationSignal) { assertNotAborted(signal); return result(listDirectory(root, args.path || '.', options.allowOutsideWorkspace)); }
    },
    {
      name: 'read_file', label: 'Read file', description: 'Read a UTF-8 file, at most 1 MiB. Returns numbered lines; use startLine to continue. Binary and legacy encodings are rejected.',
      parameters: schema({ path: string, startLine: { type: 'integer', minimum: 1 }, maxLines: { type: 'integer', minimum: 1, maximum: 500 } }, ['path']),
      async execute(_id: string, args: any, signal?: CancellationSignal) {
        assertNotAborted(signal);
        const file = readTextFile(root, args.path, options.allowOutsideWorkspace);
        const startLine = integer(args.startLine, 1, 1, 10000000);
        const maxLines = integer(args.maxLines, 200, 1, 500);
        const lines = file.content.split(/\r?\n/);
        let outputBytes = 0, truncatedLine = false;
        const selected: Array<{ line: number; text: string }> = [];
        for (let i = startLine - 1; i < Math.min(lines.length, startLine - 1 + maxLines); i++) {
          const text = lines[i].slice(0, 2000);
          if (outputBytes + Buffer.byteLength(text, 'utf8') > 48000) break;
          outputBytes += Buffer.byteLength(text, 'utf8');
          truncatedLine = truncatedLine || text.length < lines[i].length;
          selected.push({ line: i + 1, text });
        }
        return result({ path: file.path, bytes: file.bytes, totalLines: lines.length, lines: selected, nextLine: startLine + selected.length <= lines.length ? startLine + selected.length : null, truncatedLine });
      }
    },
    {
      name: 'search_files', label: 'Search files', description: 'Search UTF-8 file contents for literal text. Skips symlinks and generated/state directories (.git, node_modules, .npm-cache, .state, .runtime, release, dist). Bounded to 3000 files / 16 MiB; inspect truncated for incomplete searches.',
      parameters: schema({ query: string, path: string, caseSensitive: { type: 'boolean' }, maxResults: { type: 'integer', minimum: 1, maximum: 300 } }, ['query']),
      async execute(_id: string, args: any, signal?: CancellationSignal) { return result(await searchFiles(root, args, signal, options.allowOutsideWorkspace)); }
    },
    {
      name: 'write_file', label: 'Write file', description: 'Create or replace a UTF-8 file, at most 1 MiB. Parent directory must already exist. Refuses symlinks, binary and non-UTF-8 existing files.',
      parameters: schema({ path: string, content: string }, ['path', 'content']),
      async execute(_id: string, args: any, signal?: CancellationSignal) { assertNotAborted(signal); return result(writeTextFile(root, args.path, args.content, options.allowOutsideWorkspace)); }
    },
    {
      name: 'edit_file', label: 'Edit file', description: 'Replace exactly one occurrence of oldText with newText in a UTF-8 file. Requires a non-empty, uniquely matching oldText. Preserves all other content.',
      parameters: schema({ path: string, oldText: string, newText: string }, ['path', 'oldText', 'newText']),
      async execute(_id: string, args: any, signal?: CancellationSignal) {
        assertNotAborted(signal);
        if (typeof args.oldText !== 'string' || args.oldText.length === 0 || typeof args.newText !== 'string') throw new Error('oldText must be non-empty and newText must be a string.');
        const file = readTextFile(root, args.path, options.allowOutsideWorkspace);
        const index = file.content.indexOf(args.oldText);
        if (index < 0) throw new Error('oldText was not found; read the file before editing.');
        if (file.content.indexOf(args.oldText, index + 1) !== -1) throw new Error('oldText matches more than once; provide more surrounding context.');
        const content = file.content.slice(0, index) + args.newText + file.content.slice(index + args.oldText.length);
        return result({ ...writeTextFile(root, args.path, content, options.allowOutsideWorkspace), replacements: 1, preview: { before: args.oldText.slice(0, 12000), after: args.newText.slice(0, 12000), truncated: args.oldText.length > 12000 || args.newText.length > 12000 } });
      }
    },
    {
      name: 'run_process', label: 'Run program', description: 'Run an executable directly, without any shell, subject to the current permission mode or explicit approval. Windows requires .exe. Arguments are literal; no pipes, redirection, .cmd or .bat. Output is UTF-8, capped at 64 KiB. Cancellation only stops the direct child. This tool is not a filesystem sandbox.',
      parameters: schema({ executable: string, args: { type: 'array', items: string }, cwd: string, timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 } }, ['executable']),
      async execute(_id: string, args: any, signal?: CancellationSignal, onUpdate?: (value: any) => void) { return processResult(await runProcess(root, options, args, signal, onUpdate)); }
    },
    ...(!options.pythonRuntimeDir ? [] : [{
      name: 'run_python', label: 'Run portable Python', description: 'Run a Python script with the bundled isolated Python 3.8 interpreter. script and cwd resolve from the workspace; args are literal. No shell, arbitrary interpreter, inline code or environment overrides. Output is UTF-8, capped at 64 KiB. Every call requires approval outside full access. This is not a filesystem or network sandbox; cancellation only stops the direct child.',
      parameters: schema({ script: string, args: { type: 'array', items: string, maxItems: 250 }, cwd: string, timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 } }, ['script']),
      describeCall(args: any) { return preparePythonRun(options.pythonRuntimeDir!, root, args, { allowOutsideWorkspace: true }); },
      async execute(_id: string, args: any, signal?: CancellationSignal, onUpdate?: (value: any) => void) { return processResult(await runPython(options.pythonRuntimeDir!, root, args, { allowOutsideWorkspace: options.allowOutsideWorkspace }, signal, onUpdate)); }
    }])
  ];
}
