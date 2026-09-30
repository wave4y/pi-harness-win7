'use strict';
// Build-machine only. All downloads are pinned; no system Python/pip/registry changes.
// node scripts/fetch-python.js [--offline] [--gpg C:\absolute\path\gpg.exe]
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const {spawnSync} = require('child_process');
const {extractZip} = require('./python/zip');
const {inspectRuntime} = require('./python/pe');

const root = path.resolve(__dirname, '..');
const runtimeRoot = path.join(root, '.runtime');
const cache = path.join(runtimeRoot, 'python-cache');
const output = path.join(runtimeRoot, 'python38-x64');
const lockFile = path.join(__dirname, 'python-runtime-lock.json');
const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
const offline = process.argv.includes('--offline');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
function insideRuntime(target) {
  const absolute = path.resolve(target);
  if (!absolute.startsWith(runtimeRoot + path.sep)) throw new Error('Build path is outside .runtime');
  return absolute;
}
function cleanEnvironment() {
  const env = {};
  for (const name of Object.keys(process.env)) {
    if (!/API[_-]?KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|COOKIE|AUTH|^PYTHON|^PIP_/i.test(name)) env[name] = process.env[name];
  }
  return env;
}
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {cwd: root, env: cleanEnvironment(), windowsHide: true, shell: false,
    encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(path.basename(executable) + ' failed (' + result.status + ')\n' + result.stdout + '\n' + result.stderr);
  return result;
}
function download(url, redirects = 0) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !['www.python.org', 'files.pythonhosted.org'].includes(target.hostname)) throw new Error('Unapproved artifact host');
  return new Promise((resolve, reject) => {
    const req = https.get(target, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && redirects < 4 && res.headers.location) {
        res.resume(); resolve(download(new URL(res.headers.location, target).href, redirects + 1)); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode + ': ' + url)); return; }
      const chunks = []; let size = 0;
      res.on('data', value => { size += value.length; if (size > 64 * 1024 * 1024) req.destroy(new Error('Artifact exceeds size limit')); else chunks.push(value); });
      res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
    });
    req.setTimeout(60000, () => req.destroy(new Error('Artifact download timed out'))); req.on('error', reject);
  });
}
async function artifact(item) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(item.filename) || !/^[0-9a-f]{64}$/.test(item.sha256)) throw new Error('Invalid artifact lock');
  const file = insideRuntime(path.join(cache, item.filename));
  if (fs.existsSync(file)) {
    const data = fs.readFileSync(file);
    if (data.length !== item.size || sha256(data) !== item.sha256) throw new Error('Cached artifact SHA256 mismatch: ' + item.filename);
    return file;
  }
  if (offline) throw new Error('Offline cache is missing: ' + item.filename);
  const data = await download(item.url);
  if (data.length !== item.size || sha256(data) !== item.sha256) throw new Error('Downloaded artifact SHA256 mismatch: ' + item.filename);
  fs.writeFileSync(file, data, {flag: 'wx'});
  console.log('Verified ' + item.filename);
  return file;
}
function findGpg() {
  const at = process.argv.indexOf('--gpg');
  const candidates = at >= 0 ? [process.argv[at + 1]] : [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'gpg.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'GnuPG', 'bin', 'gpg.exe'),
  ];
  const found = candidates.find(value => value && path.isAbsolute(value) && fs.existsSync(value));
  if (!found) throw new Error('Build requires GnuPG for the pinned CPython signature. Pass --gpg with its absolute executable path.');
  return found;
}
function verifyPythonSignature(archive, signature, buildRoot) {
  const key = path.resolve(__dirname, lock.python.signature.keyFile);
  if (!key.startsWith(path.join(__dirname, 'python') + path.sep) || sha256(fs.readFileSync(key)) !== lock.python.signature.keySha256) throw new Error('Signing key hash mismatch');
  const gpgHome = insideRuntime(path.join(buildRoot, 'gpg'));
  fs.mkdirSync(gpgHome);
  const args = ['--no-options', '--homedir', gpgHome.replace(/\\/g, '/'), '--batch', '--no-autostart'];
  const executable = findGpg();
  const keyring = path.join(gpgHome, 'python-signing-key.gpg');
  // A dedicated public keyring avoids writing any user keyring or starting gpg-agent.
  run(executable, args.concat(['--output', keyring, '--dearmor', key]));
  const verified = run(executable, args.concat(['--no-default-keyring', '--keyring', keyring.replace(/\\/g, '/'), '--status-fd', '1', '--verify', signature, archive]));
  if (!verified.stdout.includes('[GNUPG:] VALIDSIG ' + lock.python.signature.fingerprint + ' ')) throw new Error('Wrong CPython signing fingerprint');
  fs.writeFileSync(path.join(buildRoot, 'python-signature-verification.txt'), verified.stdout + verified.stderr);
  return {status: 'verified', fingerprint: lock.python.signature.fingerprint, authority: lock.python.signature.authority};
}
function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Unexpected symbolic link in portable runtime');
    if (entry.isDirectory()) files.push(...walk(target)); else if (entry.isFile()) files.push(target);
  }
  return files;
}
function notices(runtime) {
  const sections = ['Portable CPython 3.8.10 and locked third-party packages.\nActual license/notice files follow; all original dist-info/license resources remain in the distribution.'];
  for (const item of lock.packages) sections.push(item.name + '==' + item.version + '\n' + item.url + '\nSHA256 ' + item.sha256);
  const files = walk(runtime).filter(file => /^(?:licen[sc]e|copying|notice|third[-_]party)(?:[._-]|$)/i.test(path.basename(file)) && !/\.py[c]?$/.test(file));
  if (!files.some(file => path.basename(file).toLowerCase() === 'license.txt')) throw new Error('Missing CPython license');
  for (const file of files) sections.push(path.relative(runtime, file).replace(/\\/g, '/') + '\n\n' + fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(path.join(runtime, 'THIRD_PARTY_NOTICES.txt'), sections.join('\n\n' + '='.repeat(72) + '\n\n') + '\n');
  return files.map(file => path.relative(runtime, file).replace(/\\/g, '/'));
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build and developer acceptance require Windows x64.');
  if (lock.schemaVersion !== 1 || lock.packages.length !== 20) throw new Error('Unexpected Python lock schema/package count');
  fs.mkdirSync(cache, {recursive: true});
  const buildRoot = fs.mkdtempSync(path.join(runtimeRoot, 'python-build-'));
  const staging = insideRuntime(path.join(buildRoot, 'runtime'));
  const builder = insideRuntime(path.join(buildRoot, 'builder'));
  const wheelhouse = insideRuntime(path.join(buildRoot, 'wheelhouse'));
  fs.mkdirSync(staging); fs.mkdirSync(builder); fs.mkdirSync(wheelhouse);
  const archive = await artifact(lock.python);
  const signature = await artifact(lock.python.signature);
  const signatureResult = verifyPythonSignature(archive, signature, buildRoot);
  const pip = await artifact(lock.buildOnly);
  // Bound concurrency and retain every error; no build starts with a partial wheel set.
  for (let i = 0; i < lock.packages.length; i += 4) {
    const group = lock.packages.slice(i, i + 4);
    const result = await Promise.allSettled(group.map(artifact));
    const failed = result.find(item => item.status === 'rejected');
    if (failed) throw failed.reason;
    result.forEach((item, index) => fs.copyFileSync(item.value, path.join(wheelhouse, group[index].filename)));
  }
  const archiveBytes = fs.readFileSync(archive);
  extractZip(archiveBytes, staging); extractZip(archiveBytes, builder);
  const target = path.join(staging, 'Lib', 'site-packages');
  const requirements = path.join(buildRoot, 'requirements.lock');
  fs.writeFileSync(requirements, lock.packages.map(item => item.name + '==' + item.version + ' --hash=sha256:' + item.sha256).join('\n') + '\n');
  // The build interpreter can import only the verified pip wheel and the target.
  // The final interpreter has exclusively relative paths and contains no pip.
  fs.writeFileSync(path.join(builder, 'python38._pth'), ['python38.zip', '.', pip, target, ''].join('\n'));
  const installed = run(path.join(builder, 'python.exe'), ['-I', '-B', '-X', 'utf8', '-u', '-m', 'pip', '--isolated', '--disable-pip-version-check',
    'install', '--no-index', '--find-links', wheelhouse, '--only-binary=:all:', '--require-hashes', '--no-compile', '--no-cache-dir', '--no-warn-script-location',
    '--target', target, '-r', requirements]);
  fs.writeFileSync(path.join(buildRoot, 'pip-install.txt'), installed.stdout + installed.stderr);
  const checked = run(path.join(builder, 'python.exe'), ['-I', '-B', '-X', 'utf8', '-u', '-m', 'pip', '--isolated', '--disable-pip-version-check', 'check']);
  fs.writeFileSync(path.join(buildRoot, 'pip-check.txt'), checked.stdout + checked.stderr);
  const removedConsoleScripts = [];
  // pip's generated Windows launchers embed the build interpreter path. The Agent
  // imports these libraries; it never uses their CLI launchers. Keep package resources.
  for (const name of ['bin', 'Scripts']) {
    const directory = insideRuntime(path.join(target, name));
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      if (!entry.isFile()) throw new Error('Unexpected directory in generated console scripts');
      const file = insideRuntime(path.join(directory, entry.name));
      removedConsoleScripts.push(path.relative(staging, file).replace(/\\/g, '/'));
      fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
  }
  fs.writeFileSync(path.join(staging, 'python38._pth'), 'python38.zip\n.\nLib/site-packages\n');
  fs.copyFileSync(path.join(__dirname, 'python', 'runtime-probe.py'), path.join(staging, 'runtime-probe.py'));
  const licenseFiles = notices(staging);
  const pe = inspectRuntime(staging);
  if (pe.files.some(item => item.machine !== 'x64')) throw new Error('Portable runtime contains non-x64 PE files');
  json(path.join(staging, 'pe-imports.json'), pe);
  const manifest = {
    schemaVersion: 1, runtimeId: lock.runtimeId, builtAt: new Date().toISOString(), lockSha256: sha256(fs.readFileSync(lockFile)),
    python: {version: lock.python.version, architecture: 'x64', executable: 'python.exe', sha256: sha256(fs.readFileSync(path.join(staging, 'python.exe'))),
      source: lock.python.url, archiveSha256: lock.python.sha256, archiveSize: lock.python.size, signature: signatureResult},
    probe: {script: 'runtime-probe.py', sha256: sha256(fs.readFileSync(path.join(staging, 'runtime-probe.py')))},
    packages: lock.packages, licenseFiles,
    requirements: {os: 'Windows 7 SP1 x64 or later; final Win7 acceptance pending', updates: ['KB2533623 or superseding DLL loader update', 'Universal CRT (KB2999226 or superseding update)'],
      notes: ['No system components were installed by this build.', 'Native wheels can have additional DLL/CPU requirements; see pe-imports.json and real-host probe results.']},
    validation: {developer: {status: 'pending', platform: os.type() + ' ' + os.release(), report: 'developer-probe.json'}, win7: {status: 'pending', tested: false}},
    build: {offlineInstallation: true, pip: {version: lock.buildOnly.version, sha256: lock.buildOnly.sha256, shipped: false}, dependencyCheck: checked.stdout.trim(),
      removedConsoleScripts, consoleScriptNote: 'pip-generated launchers reference the build interpreter; library resources and dist-info are preserved.'},
  };
  json(path.join(staging, 'runtime-manifest.json'), manifest);
  const probed = run(path.join(staging, 'python.exe'), ['-I', '-B', '-X', 'utf8', '-u', path.join(staging, 'runtime-probe.py')]);
  const report = JSON.parse(probed.stdout);
  if (!report.ok || report.modules.length !== lock.packages.length) throw new Error('Developer runtime probe failed');
  const portableReport = JSON.parse(JSON.stringify(report).split(JSON.stringify(staging).slice(1, -1)).join('<runtime>'));
  json(path.join(staging, 'developer-probe.json'), portableReport);
  manifest.validation.developer.status = 'passed';
  manifest.validation.developer.scope = 'import, exact versions, isolated paths, x64 and TLS/stdlib only; functional documents tested separately';
  const inventory = walk(staging).filter(file => path.basename(file) !== 'runtime-manifest.json').map(file => ({path: path.relative(staging, file).replace(/\\/g, '/'),
    size: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file))}));
  manifest.files = inventory;
  manifest.expandedBytes = inventory.reduce((sum, file) => sum + file.size, 0);
  json(path.join(staging, 'runtime-manifest.json'), manifest);
  if (fs.existsSync(output)) {
    const backup = insideRuntime(path.join(runtimeRoot, 'python38-x64-previous-' + Date.now()));
    fs.renameSync(insideRuntime(output), backup);
    console.log('Previous runtime preserved at ' + path.relative(root, backup));
  }
  fs.renameSync(insideRuntime(staging), insideRuntime(output));
  console.log('Ready: ' + output + '\n20 pinned packages; ' + pe.files.length + ' PE files inspected; ' + Math.round(manifest.expandedBytes / 1024 / 1024) + ' MiB extracted.');
  console.log('Developer import probe passed. Windows 7 acceptance remains pending. Build logs: ' + path.relative(root, buildRoot));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
