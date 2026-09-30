'use strict';

// Node 12 tests. Fault injection uses real Node child pipes, never an external
// Python installation. The final section also exercises the bundled interpreter
// when present; release verification can require it with PYTHON_RUNTIME_TEST_DIR.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const python = require('../dist/python-runtime.cjs');
const { createLocalTools } = require('../dist/tools.cjs');
const project = path.resolve(__dirname, '..');
const scratch = path.join(project, '.test-tmp');
fs.mkdirSync(scratch, { recursive: true });
const temporary = fs.mkdtempSync(path.join(scratch, 'python-runtime-'));
const workspace = path.join(temporary, '工作 空间');
const outside = path.join(temporary, '外部 脚本');
fs.mkdirSync(workspace); fs.mkdirSync(outside);
const script = path.join(workspace, '中文 测试.py');
const externalScript = path.join(outside, '外部.py');
fs.writeFileSync(script, 'print("test fixture")\n');
fs.writeFileSync(externalScript, 'print("external fixture")\n');
const fixtureRuntime = path.join(temporary, 'fixture runtime');
fs.mkdirSync(fixtureRuntime);
const packages = ['requests', 'urllib3', 'charset-normalizer', 'idna', 'certifi', 'numpy', 'pandas', 'python-dateutil', 'six', 'pytz', 'tzdata', 'python-docx', 'python-pptx', 'lxml', 'Pillow', 'XlsxWriter', 'openpyxl', 'et-xmlfile', 'typing_extensions', 'defusedxml'].map(name => ({ name, version: '1.0.0' }));
const sha = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
fs.writeFileSync(path.join(fixtureRuntime, 'python.exe'), 'fixture executable: never executed');
fs.writeFileSync(path.join(fixtureRuntime, 'runtime-probe.py'), '# fixed fixture probe: never executed\n');
fs.writeFileSync(path.join(fixtureRuntime, 'python38._pth'), 'python38.zip\n.\nLib/site-packages\n');
const manifest = { schemaVersion: 1, runtimeId: 'test', python: { version: '3.8.10', architecture: 'x64', executable: 'python.exe', sha256: sha(path.join(fixtureRuntime, 'python.exe')) }, probe: { script: 'runtime-probe.py', sha256: sha(path.join(fixtureRuntime, 'runtime-probe.py')) }, packages, validation: { win7: { tested: false } } };
const manifestPath = path.join(fixtureRuntime, 'runtime-manifest.json');
let generation = 0;
function saveManifest(value) { fs.writeFileSync(manifestPath, JSON.stringify(value || manifest) + '\n'.repeat(++generation)); }
saveManifest();
function report() { return { ok: true, python: { version: '3.8.10', bits: 64, isolated: true, utf8Mode: true }, modules: packages.map(entry => ({ name: entry.name, distribution: entry.name, version: entry.version, ok: true })), checks: [{ name: 'ssl', ok: true }] }; }
function signal() { return { aborted: false, listeners: new Set(), addEventListener(_, fn) { this.listeners.add(fn); }, removeEventListener(_, fn) { this.listeners.delete(fn); }, abort() { this.aborted = true; for (const fn of Array.from(this.listeners)) fn(); } }; }

async function injectedTests() {
  assert.strictEqual(python.getPythonRuntimeStatus(path.join(temporary, 'absent')).ready, false);
  assert.strictEqual(python.getPythonRuntimeStatus(path.join(temporary, 'absent')).state, 'missing');
  assert.strictEqual(python.getPythonRuntimeStatus(fixtureRuntime).state, 'not-tested');
  assert.strictEqual(python.getPythonRuntimeStatus(fixtureRuntime).ready, false);
  const plan = python.preparePythonRun(fixtureRuntime, workspace, { script: '中文 测试.py', args: ['--option', '$(not a shell)', 'a & b', '>file', '中文 "参数"'] });
  assert.strictEqual(plan.executable, path.join(fixtureRuntime, 'python.exe'));
  assert.strictEqual(plan.script, script);
  assert.strictEqual(plan.cwd, workspace);
  assert.deepStrictEqual(plan.args, ['-I', '-X', 'utf8', '-u', '-B', script, '--option', '$(not a shell)', 'a & b', '>file', '中文 "参数"']);
  for (const args of [{ script, executable: process.execPath }, { script, env: {} }, { script, code: 'print(1)' }, { script, args: [1] }, { script, args: ['bad\0arg'] }, { script, timeoutMs: 1 }, { script, timeoutMs: 120001 }]) assert.throws(() => python.preparePythonRun(fixtureRuntime, workspace, args), /only|literal|timeoutMs/);
  for (const bad of ['print(1)', '-c', 'bad\0.py', '\\\\server\\file.py', 'x.py:stream', 'NUL.py']) assert.throws(() => python.preparePythonRun(fixtureRuntime, workspace, { script: bad }));
  assert.throws(() => python.preparePythonRun(fixtureRuntime, workspace, { script: externalScript }), /outside/);
  assert.throws(() => python.preparePythonRun(fixtureRuntime, workspace, { script, cwd: outside }), /outside/);
  const localTool = createLocalTools(workspace, { pythonRuntimeDir: fixtureRuntime }).find(tool => tool.name === 'run_python');
  assert(localTool);
  assert.strictEqual(localTool.describeCall({ script: externalScript, cwd: outside }).script, externalScript);
  await assert.rejects(localTool.execute('unapproved-external', { script: externalScript }), /outside/);
  assert.strictEqual(createLocalTools(workspace).some(tool => tool.name === 'run_python'), false);

  const actualSpawn = childProcess.spawn;
  const calls = [];
  let mode = 'ready', processMode = 'echo';
  childProcess.spawn = (executable, argv, options) => {
    calls.push({ executable, argv, options });
    assert.strictEqual(executable, path.join(fixtureRuntime, 'python.exe'));
    assert.deepStrictEqual(argv.slice(0, 5), ['-I', '-X', 'utf8', '-u', '-B']);
    assert.strictEqual(options.shell, false);
    assert.strictEqual(options.windowsHide, true);
    assert(!Object.keys(options.env).some(key => /API_?KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|COOKIE|AUTH|^PYTHON/i.test(key)));
    let code;
    if (argv[5] === path.join(fixtureRuntime, 'runtime-probe.py')) {
      assert.strictEqual(argv.length, 6);
      assert.strictEqual(options.cwd, fixtureRuntime);
      const value = report();
      if (mode === 'missing-module') value.modules.pop();
      if (mode === 'wrong-version') value.modules[0].version = 'wrong';
      if (mode === 'isolation') value.python.isolated = false;
      if (mode === 'module-failure') { value.ok = false; value.modules[0].ok = false; value.modules[0].error = 'Fixture missing DLL'; }
      if (mode === 'wait') code = 'setTimeout(()=>{},10000)';
      else if (mode === 'overflow') code = 'process.stdout.write("x".repeat(200000));setTimeout(()=>{},10000)';
      else if (mode === 'invalid-json') code = 'process.stderr.write("Fixture missing DLL diagnostic");process.stdout.write("invalid");process.exitCode=1';
      else code = 'process.stdout.write(' + JSON.stringify(JSON.stringify(value)) + ');process.exitCode=' + (mode === 'module-failure' ? 1 : 0);
    } else {
      code = processMode === 'wait' ? 'setTimeout(()=>{},10000)' : processMode === 'failure' ? 'process.stderr.write("Python fixture failed");process.exitCode=7' : processMode === 'overflow' ? 'process.stdout.write("x".repeat(200000));setTimeout(()=>{},10000)' : 'process.stdout.write(' + JSON.stringify(JSON.stringify({ args: argv.slice(6), cwd: options.cwd })) + ')';
    }
    return actualSpawn(process.execPath, ['-e', code], options);
  };
  try {
    let status = await python.probePythonRuntime(fixtureRuntime, { script: externalScript });
    assert.strictEqual(status.ready, true);
    assert.strictEqual(status.probe.modules.length, 20);
    assert.strictEqual(status.win7Validated, false);
    assert.strictEqual(python.getPythonRuntimeStatus(fixtureRuntime).ready, true);
    assert.strictEqual(calls.length, 1);
    const executed = await python.runPython(fixtureRuntime, workspace, { script, args: ['中文', 'a & b', '>file'] });
    assert.deepStrictEqual(JSON.parse(executed.stdout), { args: ['中文', 'a & b', '>file'], cwd: workspace });
    assert.strictEqual(executed.script, script);
    assert.strictEqual(calls.length, 2, 'successful readiness cache avoids another import probe');
    const approved = createLocalTools(workspace, { pythonRuntimeDir: fixtureRuntime, allowOutsideWorkspace: true }).find(tool => tool.name === 'run_python');
    assert.strictEqual((await approved.execute('external', { script: externalScript, cwd: outside })).details.exitCode, 0);
    assert.strictEqual((await approved.execute('success', { script })).isError, false);
    processMode = 'failure';
    const failedTool = await approved.execute('failure', { script });
    assert.strictEqual(failedTool.isError, true);
    assert.strictEqual(failedTool.details.exitCode, 7);
    assert.strictEqual(failedTool.details.stderr, 'Python fixture failed');
    processMode = 'wait';
    assert.strictEqual((await approved.execute('timeout', { script, timeoutMs: 100 })).isError, true);
    assert.strictEqual((await python.runPython(fixtureRuntime, workspace, { script, timeoutMs: 100 })).timedOut, true);
    const cancelled = signal();
    const run = python.runPython(fixtureRuntime, workspace, { script }, {}, cancelled);
    setTimeout(() => cancelled.abort(), 80);
    assert.strictEqual((await run).cancelled, true);
    assert.strictEqual(cancelled.listeners.size, 0);
    await assert.rejects(python.runPython(fixtureRuntime, workspace, { script }, {}, cancelled), /cancelled/);
    processMode = 'overflow';
    assert.strictEqual((await approved.execute('overflow', { script })).isError, true);
    const excess = await python.runPython(fixtureRuntime, workspace, { script });
    assert.strictEqual(excess.truncated, true);
    assert(Buffer.byteLength(excess.stdout) <= 65536);
    processMode = 'echo';
    for (mode of ['module-failure', 'wrong-version', 'missing-module', 'isolation', 'invalid-json', 'overflow']) {
      saveManifest();
      assert.strictEqual(python.getPythonRuntimeStatus(fixtureRuntime).ready, false);
      status = await python.probePythonRuntime(fixtureRuntime);
      assert.strictEqual(status.ready, false, mode);
      assert.strictEqual(status.state, 'error');
      if (mode === 'module-failure') assert.strictEqual(status.probe.modules[0].error, 'Fixture missing DLL');
      if (mode === 'invalid-json') assert(status.diagnostics.stderr.includes('missing DLL'));
    }
    saveManifest(); mode = 'wait';
    const cancelledProbe = signal();
    const pending = python.probePythonRuntime(fixtureRuntime, { signal: cancelledProbe });
    setTimeout(() => cancelledProbe.abort(), 80);
    assert.strictEqual((await pending).ready, false);
    assert.strictEqual(cancelledProbe.listeners.size, 0);
    await assert.rejects(python.probePythonRuntime(fixtureRuntime, { signal: cancelledProbe }), /cancelled/);
    fs.appendFileSync(path.join(fixtureRuntime, 'runtime-probe.py'), '# changed\n');
    assert.strictEqual(python.getPythonRuntimeStatus(fixtureRuntime).state, 'invalid');
    assert(python.getPythonRuntimeStatus(fixtureRuntime).reason.includes('integrity'));
    assert.throws(() => python.preparePythonRun(fixtureRuntime, workspace, { script }), /integrity/);
  } finally { childProcess.spawn = actualSpawn; }
  console.log('PASS Python runtime: fixed executable/probe integrity, actual-probe readiness, failures, literal argv, approval paths, bounded output, timeout and cancellation.');
}

async function actualRuntimeTests() {
  const runtimeDir = process.env.PYTHON_RUNTIME_TEST_DIR || path.join(project, '.runtime', 'python38-x64');
  if (!fs.existsSync(path.join(runtimeDir, 'runtime-manifest.json')) && !process.env.PYTHON_RUNTIME_TEST_DIR) { console.log('SKIP actual Python execution: portable runtime has not been built.'); return; }
  const status = await python.probePythonRuntime(runtimeDir);
  assert.strictEqual(status.ready, true, JSON.stringify(status));
  const actualScript = path.join(workspace, '实际 Python 测试.py');
  fs.writeFileSync(actualScript, 'import sys, os, json\nfrom pathlib import Path\nPath("输出.txt").write_text("中文内容", encoding="utf-8")\nprint(json.dumps({"args":sys.argv[1:],"cwd":os.getcwd(),"isolated":bool(sys.flags.isolated),"utf8":bool(sys.flags.utf8_mode),"bytecode":not sys.dont_write_bytecode,"secrets":[k for k in os.environ if k.startswith("PYTHON") or k in ("PI_API_KEY","TEST_TOKEN")]}, ensure_ascii=False))\n');
  fs.writeFileSync(path.join(workspace, 'json.py'), 'raise RuntimeError("workspace module must not shadow stdlib")\n');
  const keys = ['PI_API_KEY', 'TEST_TOKEN', 'PYTHONPATH'];
  const previous = {};
  for (const key of keys) { previous[key] = process.env[key]; process.env[key] = workspace; }
  try {
    const output = await python.runPython(runtimeDir, workspace, { script: actualScript, args: ['空 格', '中文"参数', 'a & b', '$(literal)', '>output', '--flag'] });
    assert.strictEqual(output.exitCode, 0, output.stderr);
    assert.deepStrictEqual(JSON.parse(output.stdout), { args: ['空 格', '中文"参数', 'a & b', '$(literal)', '>output', '--flag'], cwd: workspace, isolated: true, utf8: true, bytecode: false, secrets: [] });
    assert.strictEqual(fs.readFileSync(path.join(workspace, '输出.txt'), 'utf8'), '中文内容');
    assert.strictEqual(fs.existsSync(path.join(workspace, '__pycache__')), false);
    fs.writeFileSync(actualScript, 'import time\nprint("运行中", flush=True)\ntime.sleep(10)\n');
    const timedOut = await python.runPython(runtimeDir, workspace, { script: actualScript, timeoutMs: 150 });
    assert.strictEqual(timedOut.timedOut, true);
    const cancel = signal();
    const pending = python.runPython(runtimeDir, workspace, { script: actualScript }, {}, cancel);
    setTimeout(() => cancel.abort(), 100);
    assert.strictEqual((await pending).cancelled, true);
    fs.writeFileSync(actualScript, 'print("x" * 200000)\n');
    assert.strictEqual((await python.runPython(runtimeDir, workspace, { script: actualScript })).truncated, true);
  } finally { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
  console.log('PASS bundled CPython 3.8.10: 20 imports, Chinese script/path/argv, isolated stdlib imports, no ambient secrets, no bytecode, file output, timeout, cancellation and output cap (current host only; Win7 remains pending).');
}

(async () => { await injectedTests(); await actualRuntimeTests(); })().catch(error => { console.error(error); process.exitCode = 1; });
