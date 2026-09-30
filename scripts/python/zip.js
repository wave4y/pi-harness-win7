'use strict';
// Small ZIP reader for the already hash-verified CPython embedded archive.
// Wheel extraction itself belongs to pip; never interpret ZIP member names as paths unchecked.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function extractZip(bytes, destination) {
  const root = path.resolve(destination);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('Unsupported ZIP directory');
  const entries = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16), total = 0;
  if (entries === 65535 || cursor >= end) throw new Error('ZIP64 is unsupported');
  const seen = new Set();
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP entry');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28), extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42), attributes = bytes.readUInt32LE(cursor + 38);
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameSize);
    cursor += 46 + nameSize + extraSize + commentSize;
    if (cursor > end || !name || /[\\:\x00]/.test(name) || name.startsWith('/') || name.split('/').some(p => p === '..' || p === '.') ||
        flags & 1 || ((attributes >>> 16) & 0xf000) === 0xa000) throw new Error('Unsafe ZIP entry: ' + name);
    const target = path.resolve(root, name);
    if (!target.startsWith(root + path.sep) || seen.has(target.toLowerCase())) throw new Error('Duplicate/escaping ZIP entry: ' + name);
    seen.add(target.toLowerCase());
    if (name.endsWith('/')) { fs.mkdirSync(target, {recursive: true}); continue; }
    total += size;
    if (size > 128 * 1024 * 1024 || total > 512 * 1024 * 1024 || offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error('Invalid ZIP data');
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    if (start + compressedSize > bytes.length) throw new Error('Truncated ZIP data');
    const data = bytes.slice(start, start + compressedSize);
    const unpacked = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data, {maxOutputLength: size + 1}) : null;
    if (!unpacked || unpacked.length !== size) throw new Error('Unsupported/damaged ZIP compression');
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, unpacked, {flag: 'wx'});
  }
  return {files: seen.size, uncompressedBytes: total};
}
module.exports = {extractZip};
