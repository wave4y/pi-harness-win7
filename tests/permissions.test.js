'use strict';

// Permission policy and approval lifecycle tests, runnable on bundled Node 12.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { approvalReason, validPermissionMode, permissionModes, ApprovalQueue } = require('../dist/permissions.cjs');
const scratchRoot = path.resolve(__dirname, '..', '.test-tmp');
fs.mkdirSync(scratchRoot, { recursive: true });
const temporary = fs.mkdtempSync(path.join(scratchRoot, 'permissions-'));
const workspace = path.join(temporary, 'workspace');
const outside = path.join(temporary, 'workspace-other');
fs.mkdirSync(workspace); fs.mkdirSync(outside);
fs.writeFileSync(path.join(workspace, 'inside.txt'), 'inside');
fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside');

function reason(mode, name, file, extra) {
  return approvalReason(mode, workspace, Object.assign({ name }, extra || {}), file === undefined ? {} : { path: file });
}

function policy() {
  assert.deepStrictEqual(permissionModes.map(mode => mode.value), ['read-only', 'workspace-write', 'danger-full-access']);
  for (const mode of permissionModes) assert.strictEqual(validPermissionMode(mode.value), true);
  for (const invalid of [null, undefined, '', 'full', 'read-write', '__proto__', {}, 1]) assert.strictEqual(validPermissionMode(invalid), false);
  for (const mode of ['read-only', 'workspace-write']) {
    for (const name of ['read_file', 'list_directory', 'search_files']) {
      assert.strictEqual(reason(mode, name, 'inside.txt'), null);
      assert.strictEqual(reason(mode, name, path.join(workspace, 'inside.txt')), null);
      assert.strictEqual(reason(mode, name), null);
      assert(reason(mode, name, path.join(outside, 'outside.txt')));
      assert(reason(mode, name, '../workspace-other/outside.txt'));
      assert(reason(mode, name, '..\\workspace-other\\outside.txt'));
      assert(reason(mode, name, path.join(outside, 'not-created', 'new.txt')));
      assert(reason(mode, name, null));
    }
    for (const name of ['write_file', 'edit_file', 'create_directory']) {
      assert.strictEqual(!!reason(mode, name, 'new/sub/file.txt'), mode === 'read-only');
      assert(reason(mode, name, path.join(outside, 'new.txt')));
    }
    assert(reason(mode, 'run_process', '.', { allowedExecutables: [process.execPath] }));
    assert(reason(mode, 'unknown_future_tool', '.'));
    assert.strictEqual(reason(mode, 'read_skill', '../configured-shared-skill'), null);
    for (const name of ['mcp_read', 'read_file', 'read_skill']) {
      assert(reason(mode, name, '.', { mcpServerId: 'server', readOnlyHint: true, annotations: { readOnlyHint: true, destructiveHint: false } }));
    }
  }
  for (const name of ['read_file', 'write_file', 'create_directory', 'run_process', 'unknown_future_tool', 'read_skill']) {
    assert.strictEqual(reason('danger-full-access', name, path.join(outside, 'outside.txt')), null);
    assert.strictEqual(reason('danger-full-access', name, '.', { mcpServerId: 'server' }), null);
  }
  if (process.platform === 'win32') assert.strictEqual(reason('workspace-write', 'read_file', path.join(workspace, 'inside.txt').toUpperCase()), null);
  const escaping = path.join(workspace, 'outside-link');
  const internal = path.join(workspace, 'inside-link');
  const realInside = path.join(workspace, 'real');
  fs.mkdirSync(realInside);
  fs.writeFileSync(path.join(realInside, 'file.txt'), 'kept');
  try {
    fs.symlinkSync(outside, escaping, process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync(realInside, internal, process.platform === 'win32' ? 'junction' : 'dir');
    for (const mode of ['read-only', 'workspace-write']) {
      assert(reason(mode, 'read_file', 'outside-link/outside.txt'));
      assert(reason(mode, 'write_file', 'outside-link/new/child.txt'));
      assert.strictEqual(reason(mode, 'read_file', 'inside-link/file.txt'), null);
    }
  } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; console.log('SKIP junction permissions: not available on this host.'); }
  console.log('PASS three-mode permission policy, absolute paths, future tools, MCP annotations and junction boundaries.');
}

function signal() {
  return {
    aborted: false, listeners: new Set(),
    addEventListener(type, listener) { assert.strictEqual(type, 'abort'); this.listeners.add(listener); },
    removeEventListener(type, listener) { assert.strictEqual(type, 'abort'); this.listeners.delete(listener); },
    abort() { this.aborted = true; for (const listener of Array.from(this.listeners)) listener(); }
  };
}

async function settled(promise, label) {
  let timeout;
  try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Hanging approval: ' + label)), 1000); })]); }
  finally { clearTimeout(timeout); }
}

async function lifecycle() {
  const events = [];
  const queue = new ApprovalQueue(event => events.push(event));
  const allowed = signal();
  const approval = queue.request('tool-1', 'write_file', { path: 'inside.txt' }, 'write', allowed);
  assert.strictEqual(queue.list().length, 1);
  const first = queue.list()[0];
  assert.strictEqual(first.toolCallId, 'tool-1');
  assert.deepStrictEqual(first.args, { path: 'inside.txt' });
  assert(/^[a-f0-9]{32}$/.test(first.id));
  assert.throws(() => queue.decide(first.id, 'approve-forever'), /无效/);
  assert.strictEqual(queue.list().length, 1);
  queue.decide(first.id, 'allow');
  await settled(approval, 'allow');
  assert.strictEqual(allowed.listeners.size, 0);
  assert.strictEqual(queue.list().length, 0);
  assert.throws(() => queue.decide(first.id, 'allow'), error => error.status === 409);
  assert.deepStrictEqual(events.map(event => event.type), ['approval_request', 'approval_resolved']);
  assert.strictEqual(events[1].decision, 'allow');

  const denied = signal();
  const denial = queue.request('tool-2', 'run_process', {}, 'process', denied).then(() => ({ allowed: true }), error => ({ error }));
  const second = queue.list()[0].id;
  queue.decide(second, 'deny');
  const deniedResult = await settled(denial, 'deny');
  assert(deniedResult.error.message.includes('用户拒绝'));
  assert.strictEqual(denied.listeners.size, 0);
  assert.throws(() => queue.decide(second, 'deny'), error => error.status === 409);

  const cancelled = signal();
  const pending = queue.request('tool-3', 'edit_file', {}, 'edit', cancelled).then(() => null, error => error);
  const third = queue.list()[0].id;
  cancelled.abort();
  assert((await settled(pending, 'signal abort')).message.includes('取消'));
  assert.strictEqual(cancelled.listeners.size, 0);
  assert.throws(() => queue.decide(third, 'allow'), error => error.status === 409);
  const already = signal(); already.abort();
  await assert.rejects(queue.request('tool-4', 'edit_file', {}, 'edit', already), /取消/);
  assert.strictEqual(queue.list().length, 0);

  const duringRegistration = signal();
  duringRegistration.addEventListener = function (type, listener) { this.listeners.add(listener); this.aborted = true; };
  await assert.rejects(queue.request('tool-race', 'edit_file', {}, 'edit', duringRegistration), /取消/);
  assert.strictEqual(duringRegistration.listeners.size, 0);
  assert.strictEqual(queue.list().length, 0);

  const many = Array.from({ length: 3 }, (_, index) => queue.request('parallel-' + index, 'write_file', {}, 'write').then(() => null, error => error));
  const cancelledIds = queue.list().map(item => item.id);
  queue.cancel(); queue.cancel();
  const failures = await settled(Promise.all(many), 'queue cancel');
  assert(failures.every(error => error && error.message.includes('取消')));
  assert.strictEqual(queue.list().length, 0);
  for (const id of cancelledIds) assert.throws(() => queue.decide(id, 'allow'), error => error.status === 409);
  const disconnected = new ApprovalQueue(() => { throw new Error('Observer disconnected'); });
  const observerAllow = disconnected.request('observer-1', 'write_file', {}, 'write');
  disconnected.decide(disconnected.list()[0].id, 'allow');
  await settled(observerAllow, 'throwing UI observer during allow');
  const observerCancel = disconnected.request('observer-2', 'write_file', {}, 'write').then(() => null, error => error);
  disconnected.cancel();
  assert((await settled(observerCancel, 'throwing UI observer during cancel')).message.includes('取消'));
  assert.strictEqual(disconnected.list().length, 0);
  console.log('PASS approvals allow, deny, cancellation, concurrent waits, listener cleanup and expired request rejection.');
}

(async () => { policy(); await lifecycle(); console.log('All permission tests passed.'); })().catch(error => { console.error(error); process.exitCode = 1; });
