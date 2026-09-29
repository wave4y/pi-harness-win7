'use strict';

// Runs on the bundled Node 12 runtime; intentionally does not require node:test.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listFolders } = require(process.env.TEST_FOLDERS_MODULE || '../dist/folders.cjs');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-win7-folders-'));
const originalDirectory = process.cwd();
const canonical = value => fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);

function removeTree(target) {
  const absolute = path.resolve(target);
  if (absolute !== temporary && !absolute.startsWith(temporary + path.sep)) throw new Error('Unsafe cleanup path');
  const stat = fs.lstatSync(absolute);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of fs.readdirSync(absolute)) removeTree(path.join(absolute, name));
    fs.rmdirSync(absolute);
  } else fs.unlinkSync(absolute);
}

try {
  const workspace = path.join(temporary, 'workspace');
  const other = path.join(temporary, 'other');
  fs.mkdirSync(workspace);
  fs.mkdirSync(other);
  for (const name of ['项目 空格', 'folder10', 'folder2']) fs.mkdirSync(path.join(other, name));
  const file = path.join(other, 'document.txt');
  fs.writeFileSync(file, 'unchanged');
  process.chdir(workspace);

  // A chooser can navigate outside the selected workspace, but never changes it.
  const listing = listFolders(other);
  assert.strictEqual(process.cwd(), workspace);
  assert.strictEqual(listing.path, canonical(other));
  assert.strictEqual(listing.parent, canonical(temporary));
  assert.deepStrictEqual(listing.entries.map(entry => entry.name).sort(), ['folder10', 'folder2', '项目 空格'].sort());
  assert(listing.entries.findIndex(entry => entry.name === 'folder2') < listing.entries.findIndex(entry => entry.name === 'folder10'));
  assert.strictEqual(listing.truncated, false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'unchanged');
  assert.strictEqual(listFolders(path.join(other, '项目 空格')).path, canonical(path.join(other, '项目 空格')));
  assert.deepStrictEqual(fs.readdirSync(workspace), []);

  for (const invalid of ['', '.', '..', 'relative/folder', null, 42, 'bad\0path']) {
    assert.throws(() => listFolders(invalid), error => error.status === 400);
  }
  if (process.platform === 'win32') {
    assert.throws(() => listFolders('C:folder'), error => error.status === 400);
    assert.throws(() => listFolders('\\folder'), error => error.status === 400);
    assert.throws(() => listFolders('/folder'), error => error.status === 400);
  }
  assert.throws(() => listFolders(file), error => error.status === 400);
  assert.throws(() => listFolders(path.join(temporary, 'missing')), error => error.status === 404);
  const root = path.parse(canonical(temporary)).root;
  assert.strictEqual(listFolders(root).parent, null);
  const initial = listFolders();
  try {
    const userHome = canonical(os.homedir());
    fs.accessSync(userHome, fs.constants.R_OK);
    assert(initial.roots.some(entry => entry.path === userHome));
    assert.strictEqual(initial.path, userHome);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    assert(!initial.roots.some(entry => entry.name === '用户目录'));
  }
  assert(initial.roots.some(entry => entry.path === root));

  // Deterministic permission behavior even on elevated Windows test hosts.
  const inaccessible = canonical(path.join(other, 'folder10'));
  const originalAccess = fs.accessSync;
  fs.accessSync = function (value, mode) {
    if (value === inaccessible) { const error = new Error('denied'); error.code = 'EACCES'; throw error; }
    return originalAccess.call(fs, value, mode);
  };
  try {
    assert(!listFolders(other).entries.some(entry => entry.name === 'folder10'));
    assert.throws(() => listFolders(inaccessible), error => error.status === 403);
  } finally { fs.accessSync = originalAccess; }

  const link = path.join(workspace, 'linked-project');
  let linked = false;
  try { fs.symlinkSync(other, link, process.platform === 'win32' ? 'junction' : 'dir'); linked = true; }
  catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    console.log('SKIP folder junction test: host does not permit links.');
  }
  if (linked) {
    assert.strictEqual(listFolders(link).path, canonical(other));
    assert.strictEqual(listFolders(workspace).entries.find(entry => entry.name === 'linked-project').path, canonical(other));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'unchanged');
  }

  const many = path.join(temporary, 'many');
  fs.mkdirSync(many);
  for (let index = 0; index < 1001; index++) fs.mkdirSync(path.join(many, 'folder' + index));
  const bounded = listFolders(many);
  assert.strictEqual(bounded.entries.length, 1000);
  assert.strictEqual(bounded.truncated, true);
  assert.strictEqual(bounded.entries[0].name, 'folder0');
  assert.strictEqual(bounded.entries[999].name, 'folder999');
  console.log('PASS folder browser: read-only navigation, absolute paths, Unicode, roots, permissions, junctions and bounded results.');
} finally {
  process.chdir(originalDirectory);
  removeTree(temporary);
}
