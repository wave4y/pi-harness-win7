import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// Node 12 / Windows 7 persistence. No shell, native addon or platform CLI.
const realpath = fs.realpathSync.native || fs.realpathSync;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const real = (value: string) => realpath(value);
const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const digest = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
function problem(message: string, status = 400): Error { const error: any = new Error(message); error.status = status; return error; }
function inside(root: string, target: string): boolean {
  const relative = path.relative(normalize(root), normalize(target));
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
function isObject(value: any): boolean { return !!value && typeof value === 'object' && !Array.isArray(value); }
function regularFile(file: string): boolean {
  try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink(); }
  catch (error) { if ((error as any).code === 'ENOENT') return false; throw error; }
}

export function getDefaultStateDir(environment: NodeJS.ProcessEnv = process.env): string {
  for (const value of [environment.LOCALAPPDATA, environment.APPDATA]) {
    if (value && path.isAbsolute(value) && !/[\x00-\x1f]/.test(value)) return path.join(value, 'PiWin7Web');
  }
  return process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Local', 'PiWin7Web')
    : path.join(os.homedir(), '.local', 'share', 'PiWin7Web');
}

function fsyncDirectory(directory: string): void {
  // Windows does not allow opening directories this way. File fsync and the
  // same-directory rename are still used there; never emulate rename by delete.
  if (process.platform === 'win32') return;
  let fd: number | undefined;
  try { fd = fs.openSync(directory, 'r'); fs.fsyncSync(fd); }
  catch (_) { /* Some filesystems do not support directory fsync. */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

const WINDOWS_FILE_RETRY_DELAYS = [10, 20, 40, 80, 160];
const windowsFileWait = process.platform === 'win32' ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
function retryWindowsFileLock(operation: () => void): void {
  for (let attempt = 0; ; attempt++) {
    try { operation(); return; }
    catch (error) {
      // Windows scanners and other short-lived handles can deny replacement of
      // an otherwise writable file. Keep the original destination intact and
      // retry only these errors, for at most 310 ms (six total attempts).
      if (!windowsFileWait || !['EPERM', 'EACCES', 'EBUSY'].includes((error as any).code)
        || attempt >= WINDOWS_FILE_RETRY_DELAYS.length) throw error;
      Atomics.wait(windowsFileWait, 0, 0, WINDOWS_FILE_RETRY_DELAYS[attempt]);
    }
  }
}

function writeAtomicBytes(file: string, bytes: Buffer): void {
  const directory = path.dirname(path.resolve(file));
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(file) && !regularFile(file)) throw problem('State target must be a regular file: ' + path.basename(file));
  const temporary = path.join(directory, '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
  let fd: number | undefined;
  let operationError: any;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    retryWindowsFileLock(() => fs.renameSync(temporary, file));
    fsyncDirectory(directory);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let cleanupError: any;
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (error) { cleanupError = error; }
    }
    try { retryWindowsFileLock(() => fs.unlinkSync(temporary)); }
    catch (error) { if ((error as any).code !== 'ENOENT' && !cleanupError) cleanupError = error; }
    if (!operationError && cleanupError) throw cleanupError;
  }
}

function readCandidate<T>(file: string, validate?: (value: any) => boolean): { value?: T; bytes?: Buffer; missing?: boolean; error?: boolean } {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) return { error: true };
    const bytes = fs.readFileSync(file);
    if (bytes.length > MAX_JSON_BYTES) return { error: true };
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) return { error: true };
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (validate && !validate(value)) return { error: true };
    return { value, bytes };
  } catch (error) { return (error as any).code === 'ENOENT' ? { missing: true } : { error: true }; }
}

export function saveJsonAtomic(file: string, value: any, options: { backup?: boolean } = {}): void {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw problem('State value must be JSON serializable.');
  const bytes = Buffer.from(serialized + '\n', 'utf8');
  if (bytes.length > MAX_JSON_BYTES) throw problem('State JSON exceeds 64 MiB.');
  if (options.backup !== false) {
    const previous = readCandidate(file);
    if (previous.bytes) writeAtomicBytes(file + '.bak', previous.bytes);
    else if (previous.error && regularFile(file)) {
      // Preserve damaged data for manual recovery instead of destroying it or
      // replacing a valid backup with malformed JSON.
      const damaged = file + '.corrupt-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
      fs.copyFileSync(file, damaged, fs.constants.COPYFILE_EXCL);
    }
  }
  writeAtomicBytes(file, bytes);
}

export interface JsonStateResult<T> { value: T; source: 'primary' | 'backup' | 'default'; recovered: boolean; warning?: string; }
export function readJsonState<T>(file: string, fallback: T, options: { repair?: boolean; validate?: (value: any) => boolean } = {}): JsonStateResult<T> {
  const primary = readCandidate<T>(file, options.validate);
  if (primary.bytes) return { value: primary.value!, source: 'primary', recovered: false };
  const backup = readCandidate<T>(file + '.bak', options.validate);
  if (backup.bytes) {
    let warning = 'Recovered ' + path.basename(file) + ' from its backup.';
    if (options.repair !== false) {
      try {
        if (primary.error && regularFile(file)) fs.copyFileSync(file, file + '.corrupt-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'), fs.constants.COPYFILE_EXCL);
        writeAtomicBytes(file, backup.bytes);
      } catch (_) { warning += ' The primary file could not be repaired.'; }
    }
    return { value: backup.value!, source: 'backup', recovered: true, warning };
  }
  return { value: fallback, source: 'default', recovered: false, ...(!primary.missing || !backup.missing ? { warning: 'Could not read valid state or backup: ' + path.basename(file) } : {}) };
}

interface CredentialEntry { baseUrl: string; origin: string; apiKey: string; updatedAt: string; }
interface CredentialState { version: 1; entries: { [id: string]: CredentialEntry }; removed?: string[]; }
function canonicalBaseUrl(input: string): string {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash) throw problem('API URL cannot contain credentials, query parameters or a fragment.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw problem('Remote API credentials require HTTPS.');
  return url.href.replace(/\/+$/, '');
}
function validKey(value: any): boolean { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value); }
function validCredentialState(value: any): boolean {
  if (!isObject(value) || value.version !== 1 || !isObject(value.entries) || Object.keys(value.entries).length > 256) return false;
  if (value.removed !== undefined && (!Array.isArray(value.removed) || value.removed.length > 4096 || value.removed.some((id: any) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || value.entries[id]))) return false;
  try {
    return Object.keys(value.entries).every(id => {
      const entry = value.entries[id];
      return /^[a-f0-9]{64}$/.test(id) && isObject(entry) && validKey(entry.apiKey) && typeof entry.baseUrl === 'string'
        && entry.baseUrl === canonicalBaseUrl(entry.baseUrl) && digest(entry.baseUrl) === id && new URL(entry.baseUrl).origin === entry.origin;
    });
  } catch (_) { return false; }
}
function credentials(stateDir: string): CredentialState {
  return readJsonState<CredentialState>(path.join(stateDir, 'credentials.json'), { version: 1, entries: {} }, { validate: validCredentialState }).value;
}
function saveCredentials(stateDir: string, value: CredentialState): void {
  if (!validCredentialState(value)) throw problem('Invalid credential state.');
  const file = path.join(stateDir, 'credentials.json');
  // A credential deletion/replacement must not be resurrected by recovery.
  // Both copies intentionally contain the new credential set after success.
  saveJsonAtomic(file + '.bak', value, { backup: false });
  saveJsonAtomic(file, value, { backup: false });
}
export function getStoredApiKey(stateDir: string, baseUrl: string): string {
  const canonical = canonicalBaseUrl(baseUrl);
  const entry = credentials(stateDir).entries[digest(canonical)];
  return entry && entry.baseUrl === canonical && entry.origin === new URL(canonical).origin ? entry.apiKey : '';
}
export function setStoredApiKey(stateDir: string, baseUrl: string, apiKey: string): void {
  const canonical = canonicalBaseUrl(baseUrl);
  if (typeof apiKey !== 'string') throw problem('API Key must be a string.');
  const key = apiKey.trim();
  if (!key) { clearStoredApiKey(stateDir, baseUrl); return; }
  if (!validKey(key)) throw problem('Invalid API Key format.');
  const saved = credentials(stateDir);
  if (!saved.entries[digest(canonical)] && Object.keys(saved.entries).length >= 256) throw problem('Too many saved API endpoints.');
  saved.entries[digest(canonical)] = { baseUrl: canonical, origin: new URL(canonical).origin, apiKey: key, updatedAt: new Date().toISOString() };
  if (saved.removed) saved.removed = saved.removed.filter(id => id !== digest(canonical));
  saveCredentials(stateDir, saved);
}
export function clearStoredApiKey(stateDir: string, baseUrl: string): void {
  const canonical = canonicalBaseUrl(baseUrl);
  const saved = credentials(stateDir), id = digest(canonical);
  delete saved.entries[id];
  if (!saved.removed) saved.removed = [];
  if (!saved.removed.includes(id)) saved.removed.push(id);
  saveCredentials(stateDir, saved);
}

function livePid(pid: any): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2147483647) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as any).code !== 'ESRCH' && (error as any).code !== 'EINVAL'; }
}
export function acquireStateLock(stateDir: string): () => void {
  fs.mkdirSync(stateDir, { recursive: true });
  const directory = real(stateDir), file = path.join(directory, 'instance.lock');
  const id = crypto.randomBytes(16).toString('hex');
  const content = JSON.stringify({ pid: process.pid, id, createdAt: new Date().toISOString() });
  const create = () => {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const removeOwnedGuard = (guard: string) => {
    try { const owner = JSON.parse(fs.readFileSync(guard, 'utf8')); if (owner.id === id && owner.pid === process.pid) fs.unlinkSync(guard); }
    catch (_) { /* Do not delete another owner's guard. */ }
  };
  try { create(); }
  catch (error) {
    if ((error as any).code !== 'EEXIST') throw error;
    // A recovery guard serializes stale main-lock collection and itself recovers
    // after a crash. Fresh incomplete records are protected for ten seconds.
    const guard = file + '.recovery';
    let fd = -1;
    try { fd = fs.openSync(guard, 'wx', 0o600); }
    catch (guardError) {
      if ((guardError as any).code !== 'EEXIST') throw guardError;
      const stat = fs.lstatSync(guard);
      if (!stat.isFile() || stat.isSymbolicLink()) throw problem('Data recovery lock is not a regular file.', 409);
      let owner: any;
      const before = fs.readFileSync(guard, 'utf8');
      try { owner = JSON.parse(before); } catch (_) { owner = null; }
      if ((owner && livePid(owner.pid)) || ((!owner || !Number.isInteger(owner.pid)) && Date.now() - stat.mtimeMs < 10000)) {
        throw problem('Another instance is recovering this data directory; retry after it finishes.', 409);
      }
      if (fs.readFileSync(guard, 'utf8') !== before) throw problem('Data recovery lock changed; retry shortly.', 409);
      try { fs.unlinkSync(guard); } catch (removeError) { if ((removeError as any).code !== 'ENOENT') throw removeError; }
      try { fd = fs.openSync(guard, 'wx', 0o600); }
      catch (retryError) { if ((retryError as any).code === 'EEXIST') throw problem('Another instance is recovering this data directory; retry after it finishes.', 409); throw retryError; }
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, id })); fs.fsyncSync(fd); fs.closeSync(fd); fd = -1;
      const guardOwner = JSON.parse(fs.readFileSync(guard, 'utf8'));
      if (guardOwner.id !== id || guardOwner.pid !== process.pid) throw problem('Data recovery ownership changed; retry shortly.', 409);
      let stat: fs.Stats | undefined;
      try { stat = fs.lstatSync(file); } catch (statError) { if ((statError as any).code !== 'ENOENT') throw statError; }
      if (stat) {
        if (!stat.isFile() || stat.isSymbolicLink()) throw problem('Data directory lock is not a regular file.', 409);
        let owner: any;
        try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { owner = null; }
        if (owner && livePid(owner.pid)) throw problem('This data directory is already used by a running Pi Win7 Web instance (PID ' + owner.pid + '). Close it before starting another version.', 409);
        if ((!owner || !Number.isInteger(owner.pid)) && Date.now() - stat.mtimeMs < 10000) throw problem('Data directory lock is being created; retry shortly.', 409);
        try { fs.unlinkSync(file); } catch (removeError) { if ((removeError as any).code !== 'ENOENT') throw removeError; }
      }
      try { create(); } catch (nextError) { if ((nextError as any).code === 'EEXIST') throw problem('Another Pi Win7 Web instance acquired this data directory.', 409); throw nextError; }
    } finally {
      if (fd !== -1) fs.closeSync(fd);
      removeOwnedGuard(guard);
    }
  }
  let released = false;
  const release = () => {
    if (released) return; released = true;
    process.removeListener('exit', release);
    try {
      const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (owner.id === id && owner.pid === process.pid) fs.unlinkSync(file);
    } catch (_) { /* Do not delete a different owner's or damaged lock. */ }
  };
  process.once('exit', release);
  return release;
}

export interface LegacyImportSummary {
  importedFiles: number;
  importedSessions: number;
  importedCredentials: number;
  conflicts: number;
  sources: Array<{ id: string; path: string; imported: number; skipped: number }>;
  warnings: string[];
}
interface MigrationManifest { version: 1; sources: { [id: string]: { path: string; files: { [name: string]: string }; updatedAt: string } }; }
const ROOT_STATE_FILE = /^(?:config|extensions|credentials)\.json$|^(?:session|archive)-[A-Za-z0-9_-]+\.(?:json|jsonl)$/;
function sourceDirectory(candidate: string, manual: boolean): string | undefined {
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw problem('Legacy data directory cannot be a file or symbolic link.');
    return real(candidate);
  } catch (error) { if (manual) throw problem('Could not open the selected legacy .state directory.'); return undefined; }
}

export function importLegacyState(options: { appRoot: string; stateDir: string; sourcePath?: string }): LegacyImportSummary {
  fs.mkdirSync(options.stateDir, { recursive: true });
  const destination = real(options.stateDir);
  const summary: LegacyImportSummary = { importedFiles: 0, importedSessions: 0, importedCredentials: 0, conflicts: 0, sources: [], warnings: [] };
  const candidates: string[] = [];
  if (options.sourcePath !== undefined) {
    if (!path.isAbsolute(options.sourcePath) || /[\x00-\x1f]/.test(options.sourcePath)) throw problem('Legacy source must be an absolute directory.');
    const selected = path.resolve(options.sourcePath);
    const nested = path.join(selected, '.state');
    const candidate = fs.existsSync(nested) ? nested : selected;
    const source = sourceDirectory(candidate, true)!;
    if (!fs.readdirSync(source).some(name => ROOT_STATE_FILE.test(name.replace(/\.bak$/, '')) || ['sessions', 'archives', 'pi'].includes(name))) throw problem('The selected directory contains no recognizable legacy state.');
    candidates.push(source);
  } else {
    const local = sourceDirectory(path.join(options.appRoot, '.state'), false);
    if (local) candidates.push(local);
    const parent = path.dirname(path.resolve(options.appRoot));
    try {
      const siblings = fs.readdirSync(parent, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^pi-win7-web(?:[-.]|$)/i.test(entry.name))
        .map(entry => sourceDirectory(path.join(parent, entry.name, '.state'), false)).filter((value): value is string => !!value)
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs || b.localeCompare(a));
      candidates.push(...siblings.slice(0, 128));
      if (siblings.length > 128) summary.warnings.push('Legacy package discovery stopped after 128 sibling directories.');
    } catch (_) { summary.warnings.push('Could not inspect sibling package directories for legacy state.'); }
  }
  const unique = Array.from(new Set(candidates.map(normalize)));
  const manifestPath = path.join(destination, 'legacy-imports.json');
  const manifest = readJsonState<MigrationManifest>(manifestPath, { version: 1, sources: {} }, {
    validate: value => isObject(value) && value.version === 1 && isObject(value.sources),
  }).value;
  let scannedFiles = 0;
  for (const key of unique) {
    const source = candidates.find(candidate => normalize(candidate) === key)!;
    if (key === normalize(destination)) { if (options.sourcePath) throw problem('Legacy source and current data directory are the same.'); continue; }
    const id = digest(key).slice(0, 24);
    const entry = summary.sources[summary.sources.push({ id, path: source, imported: 0, skipped: 0 }) - 1];
    const previous = manifest.sources[id];
    const history = previous && isObject(previous.files) ? previous : { path: source, files: {}, updatedAt: '' };
    const originalRoot = path.join(destination, 'legacy-imports', id);
    const list: string[] = [];
    const walk = (directory: string, relative: string, depth: number) => {
      if (depth > 8) { summary.warnings.push('Legacy nested session directory exceeds the depth limit: ' + directory); return; }
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        if (++scannedFiles > 10000) throw problem('Legacy import exceeds 10000 directory entries.');
        const next = relative ? path.join(relative, item.name) : item.name;
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory() && (relative || ['sessions', 'archives', 'pi'].includes(item.name))) walk(path.join(directory, item.name), next, depth + 1);
        else if (item.isFile()) {
          const logical = next.replace(/\.bak$/, '');
          if (relative ? /\.jsonl?$/.test(logical) : ROOT_STATE_FILE.test(logical)) if (!list.includes(logical)) list.push(logical);
        }
      }
    };
    walk(source, '', 0);
    list.sort((a, b) => (a === 'config.json' ? -1 : b === 'config.json' ? 1 : a.localeCompare(b)));
    for (const relative of list) {
      const from = path.join(source, relative);
      try {
        const actual = real(regularFile(from) ? from : from + '.bak');
        if (!inside(source, actual) || !regularFile(actual)) continue;
        const stat = fs.statSync(actual);
        if (stat.size > MAX_JSON_BYTES) { summary.warnings.push('Legacy file exceeds 64 MiB: ' + relative); continue; }
        const original = fs.readFileSync(actual);
        let value: any;
        if (relative.endsWith('.json')) {
          const loaded = readJsonState<any>(from, undefined, { repair: false });
          if (loaded.source !== 'default') value = loaded.value;
          if (loaded.recovered) summary.warnings.push('Used legacy backup for ' + relative);
        }
        const fileHash = digest(value === undefined ? original : JSON.stringify(value));
        if (history.files[relative] === fileHash) { entry.skipped++; continue; }
        const originalFile = path.join(originalRoot, relative);
        fs.mkdirSync(path.dirname(originalFile), { recursive: true });
        if (!inside(destination, real(path.dirname(originalFile)))) throw problem('Legacy backup directory points outside current data directory.');
        if (!fs.existsSync(originalFile)) writeAtomicBytes(originalFile, original);
        else if (digest(fs.readFileSync(originalFile)) !== fileHash) writeAtomicBytes(originalFile + '.' + fileHash.slice(0, 16), original);
        if (relative.endsWith('.json')) {
          if (value === undefined) { summary.warnings.push('Legacy JSON is damaged; original preserved: ' + relative); continue; }
        }
        const target = path.join(destination, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (!inside(destination, real(path.dirname(target)))) throw problem('Legacy target directory points outside current data directory.');
        const exists = fs.existsSync(target) || fs.existsSync(target + '.bak');
        let copied = false;
        if (relative === 'credentials.json') {
          if (validCredentialState(value)) {
            const current = credentials(destination);
            for (const credentialId of Object.keys(value.entries)) {
              if (!current.entries[credentialId] && !(current.removed || []).includes(credentialId)) { current.entries[credentialId] = value.entries[credentialId]; summary.importedCredentials++; copied = true; }
            }
            for (const removedId of value.removed || []) {
              if (!current.entries[removedId] && !(current.removed || []).includes(removedId)) {
                if (!current.removed) current.removed = [];
                current.removed.push(removedId); copied = true;
              }
            }
            if (copied) saveCredentials(destination, current);
          } else summary.warnings.push('Legacy credentials have no supported endpoint binding; original preserved without activating them.');
        } else if (relative === 'config.json' || relative === 'extensions.json') {
          if (!isObject(value)) { summary.warnings.push('Invalid legacy settings: ' + relative); continue; }
          if (relative === 'config.json' && Object.prototype.hasOwnProperty.call(value, 'apiKey')) {
            if (validKey(value.apiKey) && typeof value.baseUrl === 'string') {
              try {
                const credentialId = digest(canonicalBaseUrl(value.baseUrl));
                const current = credentials(destination);
                if (!current.entries[credentialId] && !(current.removed || []).includes(credentialId)) { setStoredApiKey(destination, value.baseUrl, value.apiKey); summary.importedCredentials++; }
              } catch (_) { summary.warnings.push('Legacy API key could not be bound to a valid endpoint.'); }
            } else if (value.apiKey) summary.warnings.push('Legacy API key has no valid endpoint binding; original preserved without activating it.');
            value = { ...value }; delete value.apiKey;
          }
          if (!exists) { saveJsonAtomic(target, value); copied = true; }
        } else {
          const isSession = isObject(value) && Array.isArray(value.messages);
          let conflict = false;
          if (!exists) { value === undefined ? writeAtomicBytes(target, original) : saveJsonAtomic(target, value); copied = true; }
          else {
            const existing = relative.endsWith('.json') ? readJsonState<any>(target, undefined).value : undefined;
            const same = value === undefined ? regularFile(target) && digest(fs.readFileSync(target)) === fileHash : JSON.stringify(existing) === JSON.stringify(value);
            if (!same) {
              summary.conflicts++; conflict = true;
            }
          }
          if (isSession) {
            // Current-session files are indexed by workspace/model, so every
            // imported history also gets a stable archive reachable by id.
            const forkId = digest(id + '\0' + relative + '\0' + fileHash).slice(0, 24);
            const originalId = /^[a-f0-9]{24}$/.test(value.sessionId || '') ? value.sessionId : forkId;
            let archiveId = conflict ? forkId : originalId;
            let archive = path.join(destination, 'archive-' + archiveId + '.json');
            if (fs.existsSync(archive) || fs.existsSync(archive + '.bak')) {
              const archived = readJsonState<any>(archive, undefined).value;
              if (JSON.stringify(archived) !== JSON.stringify(value)) { archiveId = forkId; archive = path.join(destination, 'archive-' + archiveId + '.json'); }
            }
            if (!fs.existsSync(archive) && !fs.existsSync(archive + '.bak')) {
              const snapshot = archiveId === value.sessionId ? value : { ...value, sessionId: archiveId, legacySessionId: value.sessionId || '', legacySource: id };
              saveJsonAtomic(archive, snapshot); copied = true;
            }
            if (copied) summary.importedSessions++;
          }
        }
        if (copied) { summary.importedFiles++; entry.imported++; } else entry.skipped++;
        history.files[relative] = fileHash;
        history.updatedAt = new Date().toISOString(); manifest.sources[id] = history;
        // Commit progress per file. A crash or failed source leaves earlier
        // imports valid, and restarting cannot duplicate conflict archives.
        saveJsonAtomic(manifestPath, manifest);
      } catch (error) { summary.warnings.push('Legacy import ' + relative + ': ' + (error as Error).message); }
    }
  }
  summary.warnings = summary.warnings.slice(0, 100);
  return summary;
}
