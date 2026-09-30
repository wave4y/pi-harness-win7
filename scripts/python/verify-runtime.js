'use strict';
// Independent offline acceptance of the built runtime, including a moved Chinese path.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const {spawn} = require('child_process');
const root = path.resolve(__dirname, '../..');
const source = path.join(root, '.runtime/python38-x64');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function walk(dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Unexpected symlink');
    out = out.concat(entry.isDirectory() ? walk(file) : [file]);
  }
  return out;
}
function verify(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'runtime-manifest.json')));
  const expected = new Map(manifest.files.map(item => [item.path, item]));
  for (const file of walk(directory)) {
    const relative = path.relative(directory, file).replace(/\\/g, '/');
    if (relative === 'runtime-manifest.json') continue;
    const entry = expected.get(relative);
    if (!entry || entry.size !== fs.statSync(file).size || entry.sha256 !== sha(fs.readFileSync(file))) throw new Error('Runtime file mismatch: ' + relative);
    if (/__pycache__|\.pyc$|(?:^|\/)pip(?:\/|-)/i.test(relative)) throw new Error('Build-only/generated file shipped: ' + relative);
    expected.delete(relative);
  }
  if (expected.size) throw new Error('Runtime is missing ' + expected.size + ' files');
  return manifest;
}
function copy(from, to) {
  fs.mkdirSync(to, {recursive: true});
  for (const entry of fs.readdirSync(from, {withFileTypes: true})) {
    if (entry.isSymbolicLink()) throw new Error('Unexpected symlink');
    const sourceFile = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) copy(sourceFile, target); else fs.copyFileSync(sourceFile, target);
  }
}
function python(directory, args, cwd) {
  return new Promise((resolve, reject) => {
    // Deliberately broken Python environment values must be ignored by -I / ._pth.
    const env = {...process.env, PYTHONPATH: 'C:\\portable-python-invalid', PYTHONHOME: 'C:\\portable-python-invalid', PYTHONSTARTUP: 'C:\\portable-python-invalid'};
    for (const name of Object.keys(env)) if (/API[_-]?KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|COOKIE|AUTH/i.test(name)) delete env[name];
    const child = spawn(path.join(directory, 'python.exe'), ['-I', '-B', '-X', 'utf8', '-u'].concat(args), {cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    const timer = setTimeout(() => child.kill(), 60000); let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error('Python exit ' + code + ': ' + stderr + stdout)); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } } });
  });
}
async function main() {
  const manifest = verify(source);
  const acceptance = fs.mkdtempSync(path.join(root, '.runtime/python-acceptance-'));
  const moved = path.join(acceptance, '搬迁目录 空格', 'Python 运行时');
  const cwd = path.join(acceptance, '另一个 工作目录'); fs.mkdirSync(cwd);
  copy(source, moved); verify(moved);
  const probe = await python(moved, [path.join(moved, 'runtime-probe.py')], cwd);
  if (!probe.ok || probe.modules.length !== 20) throw new Error('Moved runtime probe failed');
  const functional = await python(moved, [path.join(root, 'builtin-skills/portable-python/scripts/self_test.py'), '--output-dir', cwd], cwd);
  if (!functional.ok) throw new Error('Functional acceptance failed');
  const server = http.createServer((req, res) => { res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'}); res.end(JSON.stringify({ok: true, value: '中文 HTTP'})); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let request;
  try {
    const url = 'http://127.0.0.1:' + server.address().port + '/json';
    request = await python(moved, ['-c', 'import requests,json,sys; s=requests.Session(); s.trust_env=False; r=s.get(sys.argv[1],timeout=(3,3)); r.raise_for_status(); print(json.dumps(r.json(),ensure_ascii=False))', url], cwd);
    if (!request.ok || request.value !== '中文 HTTP') throw new Error('HTTP response mismatch');
  } finally { await new Promise(resolve => server.close(resolve)); }
  verify(source); verify(moved);
  const report = {schemaVersion: 1, ok: true, runtimeId: manifest.runtimeId, windows7Tested: false,
    interpreterArchiveSha256: manifest.python.archiveSha256, packageCount: manifest.packages.length,
    integrityFiles: manifest.files.length, movedChinesePath: true, differentCwd: true, hostilePythonEnvironmentIgnored: true,
    networkScope: 'one loopback HTTP request only; no external network/TLS certification',
    platform: probe.python.platform, modules: probe.modules,
    functionalChecks: functional.checks.map(check => ({name: check.name, ok: check.ok})), http: request};
  fs.writeFileSync(path.join(acceptance, 'acceptance-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log('Report: ' + path.relative(root, path.join(acceptance, 'acceptance-report.json')));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
