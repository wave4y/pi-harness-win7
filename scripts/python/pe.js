'use strict';
const fs = require('fs');
const path = require('path');

function inspectPe(bytes) {
  function bounds(offset, count) { if (!Number.isSafeInteger(offset) || offset < 0 || offset + count > bytes.length) throw new Error('PE data out of range'); }
  function u16(offset) { bounds(offset, 2); return bytes.readUInt16LE(offset); }
  function u32(offset) { bounds(offset, 4); return bytes.readUInt32LE(offset); }
  function string(offset) {
    bounds(offset, 1); const end = bytes.indexOf(0, offset);
    if (end < offset || end - offset > 4096) throw new Error('Invalid PE string');
    return bytes.toString('ascii', offset, end);
  }
  if (u16(0) !== 0x5a4d) throw new Error('Missing MZ header');
  const pe = u32(0x3c);
  if (u32(pe) !== 0x4550) throw new Error('Missing PE header');
  const machine = u16(pe + 4), sectionCount = u16(pe + 6), optional = pe + 24, optionalSize = u16(pe + 20);
  const magic = u16(optional), is64 = magic === 0x20b;
  if (!is64 && magic !== 0x10b) throw new Error('Unsupported PE optional header');
  const pointerSize = is64 ? 8 : 4, directory = optional + (is64 ? 112 : 96);
  const imageBase = is64 ? Number(bytes.readBigUInt64LE(optional + 24)) : u32(optional + 28);
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const at = optional + optionalSize + i * 40;
    sections.push({rva: u32(at + 12), size: Math.max(u32(at + 8), u32(at + 16)), offset: u32(at + 20)});
  }
  function rvaOffset(value) {
    if (value < u32(optional + 60)) { bounds(value, 1); return value; }
    const section = sections.find(s => value >= s.rva && value < s.rva + s.size);
    if (!section) throw new Error('Unmapped PE RVA: ' + value);
    const result = section.offset + value - section.rva; bounds(result, 1); return result;
  }
  function names(thunkRva) {
    if (!thunkRva) return [];
    let at = rvaOffset(thunkRva); const result = [];
    for (let i = 0; i < 100000; i++, at += pointerSize) {
      const low = u32(at), high = is64 ? u32(at + 4) : 0;
      if (low === 0 && high === 0) return result;
      if (is64 ? high & 0x80000000 : low & 0x80000000) result.push('#' + (low & 0xffff));
      else result.push(string(rvaOffset(low) + 2));
    }
    throw new Error('Unterminated PE imports');
  }
  function imports(index, delayed) {
    if (index >= u32(optional + (is64 ? 108 : 92))) return [];
    const start = u32(directory + index * 8), size = u32(directory + index * 8 + 4);
    if (!start || !size) return [];
    let at = rvaOffset(start); const result = [], stride = delayed ? 32 : 20;
    for (let i = 0; i < 4096; i++, at += stride) {
      bounds(at, stride);
      if (bytes.slice(at, at + stride).every(value => value === 0)) return result;
      const asRva = value => delayed && !(u32(at) & 1) ? value - imageBase : value;
      const dll = string(rvaOffset(asRva(u32(at + (delayed ? 4 : 12)))));
      const thunk = asRva(u32(at + (delayed ? 16 : 0)) || u32(at + (delayed ? 12 : 16)));
      result.push({dll, symbols: names(thunk)});
    }
    throw new Error('Unterminated PE import directory');
  }
  return {machine: machine === 0x8664 ? 'x64' : machine === 0x14c ? 'x86' : '0x' + machine.toString(16),
    subsystemVersion: u16(optional + 48) + '.' + u16(optional + 50), imports: imports(1, false), delayImports: imports(13, true)};
}

function inspectRuntime(root) {
  const entries = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Runtime contains a symbolic link');
      if (entry.isDirectory()) visit(target);
      else if (/\.(exe|dll|pyd)$/i.test(entry.name)) entries.push({file: path.relative(root, target).replace(/\\/g, '/'), ...inspectPe(fs.readFileSync(target))});
    }
  }
  visit(root);
  const bundled = new Set(entries.map(entry => path.basename(entry.file).toLowerCase()));
  const external = new Set();
  for (const entry of entries) for (const dependency of entry.imports.concat(entry.delayImports)) {
    if (!bundled.has(dependency.dll.toLowerCase())) external.add(dependency.dll);
  }
  return {schemaVersion: 1, scope: 'static direct and delay imports; dynamic lookups, loader search paths and CPU instructions require runtime testing',
    files: entries, dependenciesNotBundled: Array.from(external).sort(), win7Validated: false};
}
module.exports = {inspectPe, inspectRuntime};
