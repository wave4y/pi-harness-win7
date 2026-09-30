'use strict';

// Node 12 compatible test runner; no test framework or newer node:test API.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLocalTools, listDirectory, readTextFile, writeTextFile } = require(process.env.TEST_TOOLS_MODULE || '../dist/tools.cjs');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-win7-tools-'));
const workspace = path.join(temporary, 'workspace');
const outside = path.join(temporary, 'outside');
fs.mkdirSync(workspace);
fs.mkdirSync(outside);

function removeTree(target) {
  const stat = fs.lstatSync(target);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of fs.readdirSync(target)) removeTree(path.join(target, name));
    fs.rmdirSync(target);
  } else fs.unlinkSync(target);
}

class Signal {
  constructor() { this.aborted = false; this.listeners = []; }
  addEventListener(_type, callback) { this.listeners.push(callback); }
  removeEventListener(_type, callback) { this.listeners = this.listeners.filter(value => value !== callback); }
  abort() { this.aborted = true; for (const callback of this.listeners.slice()) callback(); }
}

async function main() {
  const tools = createLocalTools(workspace);
  const invoke = (name, args, signal) => tools.find(tool => tool.name === name).execute('test', args, signal);

  const created = (await invoke('create_directory', { path: 'project/src' })).details;
  assert.deepStrictEqual(created.created, ['project', 'project/src']);
  assert.deepStrictEqual((await invoke('create_directory', { path: 'project/src' })).details.created, []);
  await assert.rejects(invoke('create_directory', { path: '../outside/new' }), /outside/);
  writeTextFile(workspace, 'project/src/main.txt', 'nested file');
  await assert.rejects(invoke('create_directory', { path: 'project/src/main.txt/nested' }), /not a directory/);

  writeTextFile(workspace, '中文.txt', '你好\r\nworld\r\n');
  assert.strictEqual(readTextFile(workspace, '中文.txt').content, '你好\r\nworld\r\n');
  assert(listDirectory(workspace).entries.some(entry => entry.name === '中文.txt'));
  const page = (await invoke('read_file', { path: '中文.txt', startLine: 2, maxLines: 1 })).details;
  assert.deepStrictEqual(page.lines, [{ line: 2, text: 'world' }]);
  assert.strictEqual(page.nextLine, 3);

  for (const filename of ['../escape.txt', '..\\escape.txt', 'file.txt:secret', 'NUL', 'con.txt', 'CONOUT$', 'COM1.log', 'x.', 'x ', 'bad\0name']) {
    assert.throws(() => writeTextFile(workspace, filename, 'blocked'), /outside|Invalid|Alternate|Reserved/);
  }
  assert.throws(() => readTextFile(workspace, outside), /outside/);
  assert.throws(() => writeTextFile(workspace, 'missing/file.txt', 'x'), /ENOENT/);

  fs.writeFileSync(path.join(workspace, 'legacy.txt'), Buffer.from([0xff, 0x80]));
  assert.throws(() => readTextFile(workspace, 'legacy.txt'), /UTF-8/);
  assert.throws(() => writeTextFile(workspace, 'legacy.txt', 'overwrite'), /UTF-8/);
  fs.writeFileSync(path.join(workspace, 'utf16.txt'), Buffer.from([0xff, 0xfe, 0x61, 0]));
  assert.throws(() => readTextFile(workspace, 'utf16.txt'), /UTF-16/);
  fs.writeFileSync(path.join(workspace, 'binary.bin'), Buffer.from([1, 0, 2]));
  assert.throws(() => readTextFile(workspace, 'binary.bin'), /Binary/);
  assert.throws(() => writeTextFile(workspace, 'large.txt', 'x'.repeat(1024 * 1024 + 1)), /1 MiB/);

  writeTextFile(workspace, 'edit.txt', '\ufefffirst\r\nsecond\r\n');
  const edited = (await invoke('edit_file', { path: 'edit.txt', oldText: 'second', newText: '第三行' })).details;
  assert.deepStrictEqual(edited.preview, { before: 'second', after: '第三行', truncated: false });
  assert.strictEqual(readTextFile(workspace, 'edit.txt').content, '\ufefffirst\r\n第三行\r\n');
  await assert.rejects(invoke('edit_file', { path: 'edit.txt', oldText: '', newText: 'x' }), /non-empty/);
  await assert.rejects(invoke('edit_file', { path: 'edit.txt', oldText: 'absent', newText: 'x' }), /not found/);
  writeTextFile(workspace, 'repeated.txt', 'aaaa');
  await assert.rejects(invoke('edit_file', { path: 'repeated.txt', oldText: 'aa', newText: 'b' }), /more than once/);
  assert.strictEqual(readTextFile(workspace, 'repeated.txt').content, 'aaaa');

  for (const directory of ['.git', 'node_modules', '.npm-cache', '.state', '.runtime', 'release', 'dist']) {
    fs.mkdirSync(path.join(workspace, directory));
    fs.writeFileSync(path.join(workspace, directory, 'hidden'), 'needle');
  }
  writeTextFile(workspace, 'search.txt', 'Needle\nneedle\nlast');
  const search = (await invoke('search_files', { query: 'needle' })).details;
  assert.strictEqual(search.matches.length, 2);
  assert(search.matches.every(match => match.path === 'search.txt'));
  const limited = (await invoke('search_files', { query: 'needle', maxResults: 1 })).details;
  assert.strictEqual(limited.matches.length, 1);
  assert.strictEqual(limited.truncated, true);

  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside needle');
  const link = path.join(workspace, 'outside-link');
  let linked = false;
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); linked = true; }
  catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; console.log('SKIP symlink checks: host does not permit creating links.'); }
  if (linked) {
    assert.throws(() => readTextFile(workspace, 'outside-link/secret.txt'), /outside/);
    assert.throws(() => writeTextFile(workspace, 'outside-link/secret.txt', 'changed'), /symbolic links/);
    assert.throws(() => writeTextFile(workspace, 'outside-link/new.txt', 'changed'), /symbolic links/);
    await assert.rejects(invoke('create_directory', { path: 'outside-link/new-dir' }), /symbolic links/);
    const linkedSearch = (await invoke('search_files', { query: 'needle' })).details;
    assert.strictEqual(linkedSearch.matches.length, 2);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside needle');
  }

  await assert.rejects(invoke('run_process', { executable: process.execPath, args: ['-v'] }), /disabled/);
  const processTool = createLocalTools(workspace, { allowedExecutables: [process.execPath] }).find(tool => tool.name === 'run_process');
  const run = (args, signal, update) => processTool.execute('process', args, signal, update);
  const unlisted = path.join(workspace, 'unlisted.exe');
  fs.writeFileSync(unlisted, 'not executable');
  await assert.rejects(run({ executable: unlisted, args: [] }), /allowlist/);
  const literalArgs = ['a & b', '$(danger)', '>file', '中文', 'a"b'];
  const output = (await run({ executable: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...literalArgs] })).details;
  assert.deepStrictEqual(JSON.parse(output.stdout), literalArgs);
  assert.strictEqual(output.exitCode, 0);
  assert.strictEqual(output.childExited, true);
  const failedProcess = await run({ executable: process.execPath, args: ['-e', 'process.stderr.write("failure detail");process.exitCode=3'] });
  assert.strictEqual(failedProcess.isError, true);
  assert.strictEqual(failedProcess.details.exitCode, 3);
  assert.strictEqual(failedProcess.details.stderr, 'failure detail');
  assert.strictEqual((await run({ executable: process.execPath, args: ['-e', 'process.exitCode=0'] })).isError, false);
  const sensitiveKeys = ['PI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'test_access_token', 'test_PaSsWoRd', 'TEST_SECRET', 'TEST_CREDENTIAL', 'TEST_COOKIE', 'TEST_AUTH_HEADER', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONINSPECT', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'VIRTUAL_ENV'];
  const previousEnvironment = {};
  for (const key of sensitiveKeys.concat(['PORTABLE_TEST_MARKER'])) { previousEnvironment[key] = process.env[key]; process.env[key] = 'parent-only-test-value'; }
  try {
    const inspect = 'const names=' + JSON.stringify(sensitiveKeys) + ';process.stdout.write(JSON.stringify({present:names.filter(key=>Object.keys(process.env).some(name=>name.toUpperCase()===key.toUpperCase())),marker:process.env.PORTABLE_TEST_MARKER,path:!!process.env.PATH||!!process.env.Path}))';
    const environment = (await run({ executable: process.execPath, args: ['-e', inspect] })).details;
    assert.strictEqual(environment.exitCode, 0);
    assert.deepStrictEqual(JSON.parse(environment.stdout), { present: [], marker: 'parent-only-test-value', path: true });
  } finally {
    for (const key of Object.keys(previousEnvironment)) {
      if (previousEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = previousEnvironment[key];
    }
  }
  await assert.rejects(run({ executable: process.execPath, args: ['-v'], cwd: '..' }), /outside/);
  await assert.rejects(run({ executable: 'node', args: ['-v'] }), /absolute/);
  if (process.platform === 'win32' && process.env.ComSpec) {
    const shellTool = createLocalTools(workspace, { allowedExecutables: [process.env.ComSpec] }).find(tool => tool.name === 'run_process');
    await assert.rejects(shellTool.execute('shell', { executable: process.env.ComSpec }), /Shell/);
  }

  const updates = [];
  const splitOutput = (await run({ executable: process.execPath, args: ['-e', "const b=Buffer.from('你好'); process.stdout.write(b.slice(0,2)); setTimeout(()=>process.stdout.write(b.slice(2)),30)"] }, undefined, value => updates.push(value))).details;
  assert.strictEqual(splitOutput.stdout, '你好');
  assert(updates.length > 0);
  await assert.rejects(run({ executable: process.execPath, args: ['-e', "process.stdout.write('output');setTimeout(()=>{},5000)"] }, undefined, () => { throw new Error('observer failed'); }), /observer failed/);

  const timeout = (await run({ executable: process.execPath, args: ['-e', 'setTimeout(()=>{},5000)'], timeoutMs: 150 })).details;
  assert.strictEqual(timeout.timedOut, true);
  assert.strictEqual(timeout.terminationRequested, true);
  const signal = new Signal();
  const pending = run({ executable: process.execPath, args: ['-e', 'setTimeout(()=>{},5000)'] }, signal);
  setTimeout(() => signal.abort(), 100);
  const cancellation = (await pending).details;
  assert.strictEqual(cancellation.cancelled, true);
  assert.strictEqual(cancellation.terminationRequested, true);
  await assert.rejects(run({ executable: process.execPath, args: ['-v'] }, signal), /cancelled/);

  const excess = (await run({ executable: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(200000));setTimeout(()=>{},5000)"] })).details;
  assert.strictEqual(excess.truncated, true);
  assert(Buffer.byteLength(excess.stdout) <= 65536);
  assert.strictEqual(fs.readdirSync(workspace).some(name => name.startsWith('.agent-write-')), false);
  console.log('PASS local tools: file boundaries, UTF-8, precise edits, bounded search, literal process arguments, streaming, timeout and cancellation.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).then(() => removeTree(temporary));
