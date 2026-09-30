'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const p = require('../dist/persistence.cjs');
const base = path.resolve(__dirname, '..', '.test-tmp');
fs.mkdirSync(base, { recursive: true });
const temp = fs.mkdtempSync(path.join(base, 'persistence-'));
let checks = 0;
function check(name, run) { run(); checks++; console.log('ok - ' + name); }
function folder(name) { const dir = path.join(temp, name); fs.mkdirSync(dir, { recursive: true }); return dir; }
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); }
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function archives(dir) { return fs.readdirSync(dir).filter(name => /^archive-[a-f0-9]{24}\.json$/.test(name)).map(name => ({ name, value: read(path.join(dir, name)) })); }
function session(id, text) { return { sessionId: id, cwd: temp, messages: [{ role: 'user', content: text, timestamp: 1 }] }; }
const id = '1234567890abcdef12345678';
check('stable per-user directory', () => {
  assert.strictEqual(p.getDefaultStateDir({ LOCALAPPDATA: temp, APPDATA: folder('roaming') }), path.join(temp, 'PiWin7Web'));
  assert.strictEqual(p.getDefaultStateDir({ LOCALAPPDATA: 'relative', APPDATA: temp }), path.join(temp, 'PiWin7Web'));
  assert(path.isAbsolute(p.getDefaultStateDir({})));
  assert.notStrictEqual(p.getDefaultStateDir({}), path.join(process.cwd(), '.state'));
});
check('atomic save, damaged primary, previous-good backup and generic errors', () => {
  const dir = folder('atomic'), file = path.join(dir, 'config.json');
  p.saveJsonAtomic(file, { revision: 1 }); p.saveJsonAtomic(file, { revision: 2 });
  assert.deepStrictEqual(read(file), { revision: 2 }); assert.deepStrictEqual(read(file + '.bak'), { revision: 1 });
  write(file, '{SECRET-DO-NOT-PRINT');
  const result = p.readJsonState(file, { revision: 0 });
  assert.deepStrictEqual(result.value, { revision: 1 }); assert.strictEqual(result.source, 'backup'); assert.strictEqual(result.recovered, true);
  assert(!JSON.stringify(result).includes('SECRET-DO-NOT-PRINT')); assert.deepStrictEqual(read(file), { revision: 1 });
  assert(fs.readdirSync(dir).some(name => name.includes('.corrupt-')));
  write(file, 'broken'); write(file + '.bak', 'also broken'); assert.deepStrictEqual(p.readJsonState(file, { revision: 0 }).value, { revision: 0 });
});
check('backup-only and schema-aware recovery', () => {
  const file = path.join(folder('backup-only'), 'config.json'); write(file + '.bak', { revision: 3 });
  assert.strictEqual(p.readJsonState(file, null).value.revision, 3); write(file, { wrong: true });
  const result = p.readJsonState(file, null, { validate: value => value && typeof value.revision === 'number' });
  assert.strictEqual(result.value.revision, 3); assert.strictEqual(result.source, 'backup');
});
check('failed rename retains valid primary and removes temporary files', () => {
  const dir = folder('failed-save'), file = path.join(dir, 'state.json'); p.saveJsonAtomic(file, { retained: true });
  const rename = fs.renameSync;
  fs.renameSync = function (from, to) { if (to === file) { const e = new Error('simulated sharing violation'); e.code = 'EPERM'; throw e; } return rename.apply(fs, arguments); };
  try { assert.throws(() => p.saveJsonAtomic(file, { retained: false }), /sharing violation/); } finally { fs.renameSync = rename; }
  assert.deepStrictEqual(read(file), { retained: true }); assert(!fs.readdirSync(dir).some(name => name.endsWith('.tmp')));
  const cyclic = {}; cyclic.self = cyclic; assert.throws(() => p.saveJsonAtomic(file, cyclic)); assert.deepStrictEqual(read(file), { retained: true });
});
check('Windows transient rename failures retry the same temporary file without deleting primary', () => {
  if (process.platform !== 'win32') return;
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const file = path.join(folder('retry-' + code), 'state.json');
    p.saveJsonAtomic(file, { revision: 1 });
    const rename = fs.renameSync, wait = Atomics.wait, delays = [], sources = new Set();
    let attempts = 0;
    fs.renameSync = function (from, to) {
      if (to === file) {
        attempts++; sources.add(from);
        assert.deepStrictEqual(read(file), { revision: 1 }, 'Old primary remains valid until replacement succeeds');
        if (attempts <= 2) { const error = new Error('transient file sharing'); error.code = code; throw error; }
      }
      return rename.apply(fs, arguments);
    };
    Atomics.wait = function () { delays.push(arguments[3]); return wait.apply(Atomics, arguments); };
    try { p.saveJsonAtomic(file, { revision: 2 }); }
    finally { fs.renameSync = rename; Atomics.wait = wait; }
    assert.strictEqual(attempts, 3); assert.strictEqual(sources.size, 1);
    assert.deepStrictEqual(delays, [10, 20]);
    assert.deepStrictEqual(read(file), { revision: 2 });
    assert.deepStrictEqual(read(file + '.bak'), { revision: 1 });
  }
});
check('Windows backup replacement also recovers from a transient sharing violation', () => {
  if (process.platform !== 'win32') return;
  const file = path.join(folder('retry-backup'), 'state.json');
  p.saveJsonAtomic(file, { revision: 1 }); p.saveJsonAtomic(file, { revision: 2 });
  const rename = fs.renameSync; let attempts = 0;
  fs.renameSync = function (from, to) {
    if (to === file + '.bak' && ++attempts === 1) { const error = new Error('transient backup sharing'); error.code = 'EPERM'; throw error; }
    return rename.apply(fs, arguments);
  };
  try { p.saveJsonAtomic(file, { revision: 3 }); } finally { fs.renameSync = rename; }
  assert.strictEqual(attempts, 2);
  assert.deepStrictEqual(read(file), { revision: 3 }); assert.deepStrictEqual(read(file + '.bak'), { revision: 2 });
});
check('permanent permissions failures stop after the bounded retry schedule', () => {
  const dir = folder('retry-permanent'), file = path.join(dir, 'state.json');
  p.saveJsonAtomic(file, { revision: 1 });
  const rename = fs.renameSync, wait = Atomics.wait, delays = [];
  const failure = Object.assign(new Error('permanent permissions failure'), { code: 'EPERM', syscall: 'rename' });
  let attempts = 0;
  fs.renameSync = function (from, to) { if (to === file) { attempts++; throw failure; } return rename.apply(fs, arguments); };
  Atomics.wait = function () { delays.push(arguments[3]); return wait.apply(Atomics, arguments); };
  try { assert.throws(() => p.saveJsonAtomic(file, { revision: 2 }), error => error === failure); }
  finally { fs.renameSync = rename; Atomics.wait = wait; }
  assert.strictEqual(attempts, process.platform === 'win32' ? 6 : 1);
  assert.deepStrictEqual(delays, process.platform === 'win32' ? [10, 20, 40, 80, 160] : []);
  assert.deepStrictEqual(read(file), { revision: 1 });
  assert(!fs.readdirSync(dir).some(name => name.endsWith('.tmp')));
});
check('non-sharing IO errors are returned immediately without retrying', () => {
  const file = path.join(folder('retry-fatal'), 'state.json'); p.saveJsonAtomic(file, { revision: 1 });
  const rename = fs.renameSync, wait = Atomics.wait;
  const failure = Object.assign(new Error('no space'), { code: 'ENOSPC', syscall: 'rename' });
  let attempts = 0, waits = 0;
  fs.renameSync = function (from, to) { if (to === file) { attempts++; throw failure; } return rename.apply(fs, arguments); };
  Atomics.wait = function () { waits++; return wait.apply(Atomics, arguments); };
  try { assert.throws(() => p.saveJsonAtomic(file, { revision: 2 }), error => error === failure); }
  finally { fs.renameSync = rename; Atomics.wait = wait; }
  assert.strictEqual(attempts, 1); assert.strictEqual(waits, 0); assert.deepStrictEqual(read(file), { revision: 1 });
});
check('temporary cleanup failures cannot hide the original replacement error', () => {
  const dir = folder('retry-cleanup'), file = path.join(dir, 'state.json'); p.saveJsonAtomic(file, { revision: 1 });
  const rename = fs.renameSync, unlink = fs.unlinkSync, wait = Atomics.wait;
  const primaryFailure = Object.assign(new Error('original rename failure'), { code: 'EIO', syscall: 'rename' });
  const cleanupFailure = Object.assign(new Error('cleanup sharing failure'), { code: 'EACCES', syscall: 'unlink' });
  let failedTemp, cleanupAttempts = 0;
  fs.renameSync = function (from, to) { if (to === file) { failedTemp = from; throw primaryFailure; } return rename.apply(fs, arguments); };
  fs.unlinkSync = function (target) { if (target === failedTemp) { cleanupAttempts++; throw cleanupFailure; } return unlink.apply(fs, arguments); };
  Atomics.wait = function () { return 'timed-out'; };
  try { assert.throws(() => p.saveJsonAtomic(file, { revision: 2 }), error => error === primaryFailure); }
  finally { fs.renameSync = rename; fs.unlinkSync = unlink; Atomics.wait = wait; if (failedTemp && fs.existsSync(failedTemp)) fs.unlinkSync(failedTemp); }
  assert.strictEqual(cleanupAttempts, process.platform === 'win32' ? 6 : 1);
  assert.deepStrictEqual(read(file), { revision: 1 });
});
check('credentials bind full API URL and clearing does not resurrect old backup', () => {
  const dir = folder('credentials'); p.setStoredApiKey(dir, 'https://EXAMPLE.com:443/v1/', 'first-key');
  assert.strictEqual(p.getStoredApiKey(dir, 'https://example.com/v1'), 'first-key');
  assert.strictEqual(p.getStoredApiKey(dir, 'https://example.com/other'), ''); assert.strictEqual(p.getStoredApiKey(dir, 'https://other.example/v1'), '');
  p.setStoredApiKey(dir, 'https://example.com/other', 'other-key'); p.setStoredApiKey(dir, 'https://example.com/v1', 'replacement-key');
  assert(!fs.readFileSync(path.join(dir, 'credentials.json.bak'), 'utf8').includes('first-key'));
  p.clearStoredApiKey(dir, 'https://example.com/v1'); assert.strictEqual(p.getStoredApiKey(dir, 'https://example.com/v1'), '');
  assert(!fs.readFileSync(path.join(dir, 'credentials.json.bak'), 'utf8').includes('replacement-key'));
  write(path.join(dir, 'credentials.json'), 'broken'); assert.strictEqual(p.getStoredApiKey(dir, 'https://example.com/v1'), '');
  assert.strictEqual(p.getStoredApiKey(dir, 'https://example.com/other'), 'other-key');
  for (const url of ['ftp://remote.example/v1', 'http://user:secret@example.com/v1', 'https://user:secret@example.com/v1', 'http://example.com/v1?token=secret', 'https://example.com/v1?token=secret', 'http://example.com/v1#fragment', 'https://example.com/v1#fragment']) assert.throws(() => p.setStoredApiKey(dir, url, 'key'));
  p.setStoredApiKey(dir, 'http://127.0.0.1:1234/v1', 'local-key'); assert.strictEqual(p.getStoredApiKey(dir, 'http://127.0.0.1:1234/v1'), 'local-key');
});
check('remote HTTP keys persist and recover independently from HTTPS and other endpoints', () => {
  const dir = folder('http-credentials');
  p.setStoredApiKey(dir, 'http://REMOTE.EXAMPLE:80/v1/', 'http-fixture-key');
  assert.strictEqual(p.getStoredApiKey(dir, 'http://remote.example/v1'), 'http-fixture-key');
  assert.strictEqual(p.getStoredApiKey(dir, 'https://remote.example/v1'), '', 'Changing protocol must not reuse the HTTP key');
  p.setStoredApiKey(dir, 'https://remote.example/v1', 'https-fixture-key');
  p.setStoredApiKey(dir, 'http://192.168.1.2:8080/api/v1', 'lan-fixture-key');
  assert.strictEqual(p.getStoredApiKey(dir, 'http://remote.example:8080/v1'), '');
  assert.strictEqual(p.getStoredApiKey(dir, 'http://remote.example/other'), '');
  write(path.join(dir, 'credentials.json'), 'damaged');
  assert.strictEqual(p.getStoredApiKey(dir, 'http://remote.example/v1'), 'http-fixture-key');
  assert.strictEqual(p.getStoredApiKey(dir, 'https://remote.example/v1'), 'https-fixture-key');
  assert.strictEqual(p.getStoredApiKey(dir, 'http://192.168.1.2:8080/api/v1/'), 'lan-fixture-key');
  p.clearStoredApiKey(dir, 'http://remote.example/v1');
  write(path.join(dir, 'credentials.json'), 'damaged again');
  assert.strictEqual(p.getStoredApiKey(dir, 'http://remote.example/v1'), '');
  assert.strictEqual(p.getStoredApiKey(dir, 'https://remote.example/v1'), 'https-fixture-key', 'Clearing HTTP must not clear HTTPS');
});
check('state lock excludes live owner and release is idempotent', () => {
  const dir = folder('lock'), release = p.acquireStateLock(dir); assert.throws(() => p.acquireStateLock(dir), err => err.status === 409);
  release(); release(); const again = p.acquireStateLock(dir); again(); assert(!fs.existsSync(path.join(dir, 'instance.lock')));
});
check('stale main and recovery locks recover; fresh malformed locks are protected', () => {
  const dir = folder('stale-lock'), file = path.join(dir, 'instance.lock'), guard = file + '.recovery';
  write(file, { pid: 2147483647, id: 'old' }); write(guard, { pid: 2147483647, id: 'old-guard' });
  const release = p.acquireStateLock(dir); release(); assert(!fs.existsSync(guard));
  write(file, 'partial'); assert.throws(() => p.acquireStateLock(dir), err => err.status === 409);
  const old = new Date(Date.now() - 60000); fs.utimesSync(file, old, old); write(guard, 'partial');
  assert.throws(() => p.acquireStateLock(dir), err => err.status === 409);
  fs.utimesSync(guard, old, old); const recovered = p.acquireStateLock(dir); recovered();
});
check('normal process exit releases the lock without a shell', () => {
  const dir = folder('exit-lock'), moduleFile = path.resolve(__dirname, '../dist/persistence.cjs');
  const result = cp.spawnSync(process.execPath, ['-e', 'require(' + JSON.stringify(moduleFile) + ').acquireStateLock(' + JSON.stringify(dir) + ')'], { encoding: 'utf8', shell: false, timeout: 10000 });
  assert.strictEqual(result.status, 0, result.stderr); assert(!fs.existsSync(path.join(dir, 'instance.lock')));
});
check('automatic import scans only own state and direct old-package siblings, archives conflicts and deduplicates', () => {
  const parent = folder('auto'), appRoot = path.join(parent, 'current'), stateDir = path.join(parent, 'stable');
  const own = path.join(appRoot, '.state'), old = path.join(parent, 'pi-win7-web-old', '.state');
  write(path.join(own, 'config.json'), { baseUrl: 'https://old.example/v1', apiKey: 'legacy-key', model: 'first' });
  write(path.join(own, 'session-workspace.json'), session(id, 'current legacy history'));
  write(path.join(old, 'config.json'), { model: 'second' }); write(path.join(old, 'session-workspace.json'), session(id, 'other legacy history'));
  write(path.join(parent, 'unrelated', '.state', 'session-ignored.json'), session('aaaaaaaaaaaaaaaaaaaaaaaa', 'unrelated'));
  write(path.join(parent, 'nested', 'pi-win7-web-nested', '.state', 'session-ignored.json'), session('bbbbbbbbbbbbbbbbbbbbbbbb', 'nested'));
  const result = p.importLegacyState({ appRoot, stateDir }); assert.strictEqual(result.sources.length, 2);
  assert.strictEqual(read(path.join(stateDir, 'config.json')).model, 'first'); assert(!Object.prototype.hasOwnProperty.call(read(path.join(stateDir, 'config.json')), 'apiKey'));
  assert.strictEqual(p.getStoredApiKey(stateDir, 'https://old.example/v1'), 'legacy-key');
  assert.strictEqual(read(path.join(stateDir, 'session-workspace.json')).messages[0].content, 'current legacy history');
  assert.deepStrictEqual(archives(stateDir).map(x => x.value.messages[0].content).sort(), ['current legacy history', 'other legacy history']);
  for (const entry of archives(stateDir)) assert.strictEqual(entry.name, 'archive-' + entry.value.sessionId + '.json');
  assert.strictEqual(read(path.join(own, 'config.json')).apiKey, 'legacy-key');
  const repeated = p.importLegacyState({ appRoot, stateDir }); assert.strictEqual(repeated.importedFiles, 0); assert.strictEqual(repeated.importedSessions, 0); assert.strictEqual(archives(stateDir).length, 2);
  write(path.join(old, 'session-workspace.json'), session(id, 'third legacy history')); assert.strictEqual(p.importLegacyState({ appRoot, stateDir }).importedSessions, 1); assert.strictEqual(archives(stateDir).length, 3);
});
check('import preserves current settings and secrets plus divergent same-ID current and archived history', () => {
  const appRoot = folder('preserve-app'), stateDir = folder('preserve-target'), old = path.join(appRoot, '.state');
  write(path.join(old, 'config.json'), { baseUrl: 'https://example.com/v1', apiKey: 'old-key', model: 'old-model' }); write(path.join(old, 'extensions.json'), { skills: ['old'] });
  write(path.join(old, 'session-workspace.json'), session(id, 'legacy current')); write(path.join(old, 'archive-' + id + '.json'), session(id, 'legacy archive'));
  write(path.join(stateDir, 'config.json'), { model: 'new-model' }); write(path.join(stateDir, 'extensions.json'), { skills: ['new'] });
  write(path.join(stateDir, 'session-workspace.json'), session(id, 'new current')); write(path.join(stateDir, 'archive-' + id + '.json'), session(id, 'new archive'));
  p.setStoredApiKey(stateDir, 'https://example.com/v1', 'new-key'); const result = p.importLegacyState({ appRoot, stateDir }); assert(result.conflicts >= 2);
  assert.strictEqual(read(path.join(stateDir, 'config.json')).model, 'new-model'); assert.deepStrictEqual(read(path.join(stateDir, 'extensions.json')), { skills: ['new'] });
  assert.strictEqual(p.getStoredApiKey(stateDir, 'https://example.com/v1'), 'new-key'); assert.strictEqual(read(path.join(stateDir, 'session-workspace.json')).messages[0].content, 'new current');
  assert.deepStrictEqual(archives(stateDir).map(x => x.value.messages[0].content).sort(), ['legacy archive', 'legacy current', 'new archive']);
});
check('backup-only and damaged legacy JSON recover without changing source, native JSONL preserved', () => {
  const appRoot = folder('legacy-backups'), source = path.join(appRoot, '.state'), stateDir = folder('backup-target');
  write(path.join(source, 'config.json.bak'), { model: 'backup-model' }); write(path.join(source, 'session-workspace.json'), '{broken'); write(path.join(source, 'session-workspace.json.bak'), session(id, 'recovered legacy'));
  write(path.join(source, 'sessions', 'native.jsonl'), '{"type":"session"}\n{"type":"message"}\n');
  const result = p.importLegacyState({ appRoot, stateDir }); assert.strictEqual(read(path.join(stateDir, 'config.json')).model, 'backup-model'); assert.strictEqual(archives(stateDir)[0].value.messages[0].content, 'recovered legacy');
  assert(result.warnings.length > 0); assert.strictEqual(fs.readFileSync(path.join(source, 'session-workspace.json'), 'utf8'), '{broken');
  assert.strictEqual(fs.readFileSync(path.join(stateDir, 'sessions', 'native.jsonl'), 'utf8'), '{"type":"session"}\n{"type":"message"}\n');
});
check('manual import accepts package or state path, only chosen source, meaningful errors for absent state', () => {
  const parent = folder('manual'), appRoot = path.join(parent, 'app'), source = path.join(parent, 'chosen', '.state'), stateDir = folder('manual-target');
  write(path.join(source, 'session-chosen.json'), session(id, 'chosen')); write(path.join(appRoot, '.state', 'session-other.json'), session('cccccccccccccccccccccccc', 'other'));
  const result = p.importLegacyState({ appRoot, stateDir, sourcePath: path.dirname(source) }); assert.strictEqual(result.sources.length, 1); assert.strictEqual(archives(stateDir).length, 1); assert.strictEqual(archives(stateDir)[0].value.messages[0].content, 'chosen');
  assert.strictEqual(p.importLegacyState({ appRoot, stateDir, sourcePath: source }).importedFiles, 0);
  for (const sourcePath of [path.join(parent, 'missing'), folder('empty-source'), 'relative']) assert.throws(() => p.importLegacyState({ appRoot, stateDir, sourcePath }), err => err.status === 400);
});
check('legacy directory links are skipped', () => {
  const appRoot = folder('links-app'), source = path.join(appRoot, '.state'), outside = folder('outside'), stateDir = folder('links-target');
  write(path.join(source, 'config.json'), { model: 'safe' }); write(path.join(outside, 'secret.json'), session(id, 'outside'));
  fs.symlinkSync(outside, path.join(source, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
  p.importLegacyState({ appRoot, stateDir }); assert(!fs.existsSync(path.join(stateDir, 'sessions', 'secret.json'))); assert.strictEqual(archives(stateDir).length, 0);
});
check('explicit key deletion survives changed legacy sources and lost import manifest', () => {
  const appRoot = folder('deleted-key-app'), source = path.join(appRoot, '.state'), stateDir = folder('deleted-key-target');
  const url = 'https://deleted.example/v1';
  write(path.join(source, 'config.json'), { model: 'old-one', baseUrl: url, apiKey: 'deleted-key' });
  p.importLegacyState({ appRoot, stateDir });
  assert.strictEqual(p.getStoredApiKey(stateDir, url), 'deleted-key');
  p.clearStoredApiKey(stateDir, url);
  write(path.join(source, 'config.json'), { model: 'old-two', baseUrl: url, apiKey: 'deleted-key' });
  p.setStoredApiKey(source, url, 'deleted-key');
  p.importLegacyState({ appRoot, stateDir });
  assert.strictEqual(p.getStoredApiKey(stateDir, url), '');
  for (const suffix of ['', '.bak']) { const manifest = path.join(stateDir, 'legacy-imports.json' + suffix); if (fs.existsSync(manifest)) fs.unlinkSync(manifest); }
  p.importLegacyState({ appRoot, stateDir });
  assert.strictEqual(p.getStoredApiKey(stateDir, url), '');
  write(path.join(stateDir, 'credentials.json'), 'damaged');
  assert.strictEqual(p.getStoredApiKey(stateDir, url), '');
  p.setStoredApiKey(stateDir, url, 'explicit-new-key');
  assert.strictEqual(p.getStoredApiKey(stateDir, url), 'explicit-new-key');
});
check('unsupported legacy inline API keys are preserved only in original copies', () => {
  const appRoot = folder('unbound-key-app'), source = path.join(appRoot, '.state'), stateDir = folder('unbound-key-target');
  write(path.join(source, 'config.json'), { model: 'legacy', apiKey: 'unbound-legacy-secret' });
  const imported = p.importLegacyState({ appRoot, stateDir });
  assert.strictEqual(read(path.join(source, 'config.json')).apiKey, 'unbound-legacy-secret');
  assert(!Object.prototype.hasOwnProperty.call(read(path.join(stateDir, 'config.json')), 'apiKey'));
  assert.strictEqual(imported.importedCredentials, 0);
  assert(!JSON.stringify(imported).includes('unbound-legacy-secret'));
});
console.log('Persistence tests passed (' + checks + ') on ' + process.version);
