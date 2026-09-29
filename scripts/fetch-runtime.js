'use strict';
// Runs on the build machine. The downloaded runtime is only executed after SHA-256 verification.
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const version = 'v12.22.12';
const architecture = process.argv.includes('--x86') ? 'x86' : 'x64';
const base = 'https://nodejs.org/dist/' + version + '/';
function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && redirects < 5 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url);
        if (next.protocol !== 'https:' || next.hostname !== 'nodejs.org') { reject(new Error('Unexpected download redirect')); return; }
        resolve(download(next.href, redirects + 1)); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode + ' ' + url)); return; }
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
    });
    req.setTimeout(60000, () => req.destroy(new Error('Download timed out'))); req.on('error', reject);
  });
}
(async () => {
  const relative = 'win-' + architecture + '/node.exe';
  const sums = (await download(base + 'SHASUMS256.txt')).toString('utf8');
  const line = sums.split(/\r?\n/).find(line => line.trim().endsWith('  ' + relative));
  if (!line) throw new Error('Runtime is missing from official checksums');
  const expected = line.split(/\s+/)[0];
  const bytes = await download(base + relative);
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error('SHA-256 mismatch; runtime was not written');
  const dir = path.resolve(__dirname, '../.runtime', architecture);
  fs.mkdirSync(dir, {recursive: true}); fs.writeFileSync(path.join(dir, 'node.exe'), bytes);
  // Node's full license also includes its statically bundled dependencies.
  fs.writeFileSync(path.join(dir, 'LICENSE'), await download('https://raw.githubusercontent.com/nodejs/node/' + version + '/LICENSE'));
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({version, architecture, url: base + relative, sha256: actual}, null, 2));
  console.log('Verified ' + version + ' ' + architecture + ': ' + actual);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
