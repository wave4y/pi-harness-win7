'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const arch = process.argv.includes('--x86') ? 'x86' : 'x64';
const runtime = path.join(root, '.runtime', arch);
const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'runtime.json'), 'utf8'));
const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(runtime, 'node.exe'))).digest('hex');
if (digest !== manifest.sha256) throw new Error('Runtime checksum mismatch');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'release', 'pi-win7-web-' + version + '-' + arch);
if (fs.existsSync(output) && fs.readdirSync(output).length) {
  throw new Error('Release directory is not empty. Use a new version or move the reviewed old output before packaging: ' + output);
}
function copyTree(src, dst) {
  fs.mkdirSync(dst, {recursive: true});
  for (const item of fs.readdirSync(src, {withFileTypes: true})) {
    if (item.isDirectory()) copyTree(path.join(src, item.name), path.join(dst, item.name));
    else if (item.isFile()) fs.copyFileSync(path.join(src, item.name), path.join(dst, item.name));
  }
}
fs.mkdirSync(path.join(output, 'dist'), {recursive: true});
for (const name of ['server.cjs', 'server.cjs.map', 'build-meta.json', 'THIRD_PARTY_NOTICES.txt']) fs.copyFileSync(path.join(root, 'dist', name), path.join(output, 'dist', name));
copyTree(path.join(root, 'dist', 'public'), path.join(output, 'dist', 'public'));
copyTree(runtime, path.join(output, 'runtime'));
for (const name of ['launch.vbs', 'README.md', 'VALIDATION.md', 'PI-MIGRATION.md', 'LICENSE']) fs.copyFileSync(path.join(root, name), path.join(output, name));
fs.mkdirSync(path.join(output, 'workspace'), {recursive: true});
copyTree(path.join(root, 'examples'), path.join(output, 'examples'));
copyTree(path.join(root, 'examples', 'skills'), path.join(output, 'workspace', '.agents', 'skills'));
copyTree(path.join(root, 'examples', 'prompts'), path.join(output, 'workspace', '.pi', 'prompts'));
console.log(output);
