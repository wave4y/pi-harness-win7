'use strict';
// Run with Node 12 or later; no downloads or third-party Python execution.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {extractZip} = require('./zip');
const {inspectPe} = require('./pe');
const root = path.resolve(__dirname, '../../.runtime');
fs.mkdirSync(root, {recursive: true});
const scratch = fs.mkdtempSync(path.join(root, 'python-parser-test-'));

function zip(name, text) {
  const member = Buffer.from(name), data = Buffer.from(text), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(member.length, 26);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(member.length, 28);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + member.length, 12); end.writeUInt32LE(local.length + member.length + data.length, 16);
  return Buffer.concat([local, member, data, central, member, end]);
}
extractZip(zip('inside/ok.txt', 'verified data'), path.join(scratch, 'good'));
assert.strictEqual(fs.readFileSync(path.join(scratch, 'good/inside/ok.txt'), 'utf8'), 'verified data');
for (const name of ['../outside', 'a/../../outside', '/absolute', 'C:/absolute', 'back\\slash', 'x\0y']) {
  assert.throws(() => extractZip(zip(name, 'bad'), path.join(scratch, 'unsafe')), /Unsafe|escaping/);
}
assert.throws(() => extractZip(Buffer.from('not a ZIP'), path.join(scratch, 'bad')), /ZIP/);
assert.throws(() => extractZip(zip('ok', 'data').slice(0, -1), path.join(scratch, 'truncated')), /ZIP/);
assert.throws(() => inspectPe(Buffer.from('not an executable')), /MZ/);

// A synthetic x64 image with named/ordinal normal imports and a delay import.
const pe = Buffer.alloc(4096);
pe.writeUInt16LE(0x5a4d, 0); pe.writeUInt32LE(128, 0x3c); pe.writeUInt32LE(0x4550, 128);
pe.writeUInt16LE(0x8664, 132); pe.writeUInt16LE(1, 134); pe.writeUInt16LE(240, 148);
const opt = 152;
pe.writeUInt16LE(0x20b, opt); pe.writeBigUInt64LE(BigInt('0x140000000'), opt + 24);
pe.writeUInt16LE(6, opt + 48); pe.writeUInt16LE(1, opt + 50); pe.writeUInt32LE(1024, opt + 60); pe.writeUInt32LE(16, opt + 108);
pe.writeUInt32LE(0x1000, opt + 112 + 8); pe.writeUInt32LE(40, opt + 112 + 12);
pe.writeUInt32LE(0x1200, opt + 112 + 13 * 8); pe.writeUInt32LE(64, opt + 112 + 13 * 8 + 4);
const section = opt + 240;
pe.writeUInt32LE(3072, section + 8); pe.writeUInt32LE(0x1000, section + 12); pe.writeUInt32LE(3072, section + 16); pe.writeUInt32LE(1024, section + 20);
pe.writeUInt32LE(0x1080, 1024); pe.writeUInt32LE(0x1060, 1024 + 12);
pe.write('KERNEL32.dll\0', 1024 + 0x60); pe.writeBigUInt64LE(BigInt(0x10b0), 1024 + 0x80);
pe.writeBigUInt64LE(BigInt('0x8000000000000007'), 1024 + 0x88); pe.write('LoadLibraryExW\0', 1024 + 0xb2);
pe.writeUInt32LE(1, 1024 + 0x200); pe.writeUInt32LE(0x1260, 1024 + 0x204); pe.writeUInt32LE(0x1280, 1024 + 0x210);
pe.write('delayed.dll\0', 1024 + 0x260); pe.writeBigUInt64LE(BigInt(0x12b0), 1024 + 0x280); pe.write('Deferred\0', 1024 + 0x2b2);
const parsed = inspectPe(pe);
assert.strictEqual(parsed.machine, 'x64'); assert.strictEqual(parsed.subsystemVersion, '6.1');
assert.deepStrictEqual(parsed.imports, [{dll: 'KERNEL32.dll', symbols: ['LoadLibraryExW', '#7']}]);
assert.deepStrictEqual(parsed.delayImports, [{dll: 'delayed.dll', symbols: ['Deferred']}]);
console.log('Python build parsers: ZIP traversal/truncation and PE normal/delay/ordinal imports passed.');
