'use strict';
// Real server, separate version directories, a fake provider, and a private user
// profile. Never read or mutate the developer's actual application data.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const {spawn} = require('child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(root, '.test-tmp', 'persistent-integration-'));
const profile = path.join(temp, 'profile');
const workspace = path.join(temp, 'project');
const installs = path.join(temp, 'versions');
fs.mkdirSync(workspace, {recursive: true});
fs.mkdirSync(installs, {recursive: true});
const versionA = path.join(installs, 'pi-win7-web-test-a');
const versionB = path.join(installs, 'pi-win7-web-test-b');
for (const directory of [versionA, versionB]) {
  fs.mkdirSync(path.join(directory, 'dist'), {recursive: true});
  fs.copyFileSync(path.join(root, 'dist', 'server.cjs'), path.join(directory, 'dist', 'server.cjs'));
}
const key = 'fake-persistence-test-key-' + process.pid;
let child, port, token, providerFailure;
const processes = new Set(), sockets = new Set();
function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers = {'X-Agent-Token': token || ''};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({hostname: '127.0.0.1', port, method, path: route, headers}, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('error', reject); res.on('end', () => {
        try { resolve({status: res.statusCode, text, json: (res.headers['content-type'] || '').includes('application/json') ? JSON.parse(text) : null}); } catch (error) { reject(error); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('API timeout: ' + route))); req.on('error', reject); req.end(data);
  });
}
async function ok(method, route, body) { const result = await request(method, route, body); assert.strictEqual(result.status, 200, result.text); return result.json; }
async function start(directory) {
  let output = '';
  const processHandle = spawn(process.execPath, [path.join(directory, 'dist', 'server.cjs'), '--port', '0'], {
    cwd: directory, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {LOCALAPPDATA: profile, APPDATA: profile, PI_API_KEY: '', PI_MODEL: '', PI_BASE_URL: ''})
  });
  processes.add(processHandle); processHandle.once('exit', () => processes.delete(processHandle));
  const foundPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { processHandle.kill(); reject(new Error('Startup timeout: ' + output)); }, 15000);
    processHandle.once('error', error => { clearTimeout(timer); reject(error); });
    processHandle.once('exit', () => { clearTimeout(timer); reject(new Error('Startup exited: ' + output)); });
    processHandle.stderr.on('data', chunk => output += chunk);
    processHandle.stdout.on('data', chunk => { output += chunk; const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
  });
  child = processHandle; port = foundPort;
  const boot = (await request('GET', '/api/bootstrap')).json; token = boot.csrfToken;
  assert(!JSON.stringify(boot).includes(key));
  return boot;
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const current = child;
  await new Promise(resolve => { current.once('exit', resolve); current.kill(); });
  child = null;
}
function frame(delta, finish) { return 'data: ' + JSON.stringify({choices: [{index: 0, delta: delta || {}, finish_reason: finish || null}]}) + '\n\n'; }
const provider = http.createServer((req, res) => {
  let raw = ''; req.setEncoding('utf8'); req.on('data', chunk => raw += chunk); req.on('end', () => {
    try {
      const input = JSON.parse(raw);
      assert.strictEqual(req.headers.authorization, 'Bearer ' + key);
      const lastUser = input.messages.filter(message => message.role === 'user').slice(-1)[0];
      const text = lastUser && lastUser.content;
      res.writeHead(200, {'Content-Type': 'text/event-stream'});
      if (text === 'CRASH DURING TOOL' && input.messages[input.messages.length - 1].role !== 'tool') {
        res.end(frame({tool_calls: [{index: 0, id: 'crash-tool', type: 'function', function: {name: 'write_file', arguments: JSON.stringify({path: 'must-not-replay.txt', content: 'never execute automatically'})}}]}) + frame({}, 'tool_calls') + 'data: [DONE]\n\n');
      } else if (text === 'CRASH DURING TEXT') {
        res.write(frame({content: 'PARTIAL ANSWER PRESERVED'}));
      } else {
        // Any recovered tool call must have a corresponding result before a new user turn.
        let pending = new Set();
        for (const message of input.messages) {
          if (message.role === 'tool') { assert(pending.delete(message.tool_call_id)); continue; }
          assert.strictEqual(pending.size, 0, 'Unmatched tool call reached provider');
          for (const call of message.tool_calls || []) pending.add(call.id);
        }
        assert.strictEqual(pending.size, 0);
        res.end(frame({content: 'PERSISTENT ANSWER'}) + frame({}, 'stop') + 'data: [DONE]\n\n');
      }
    } catch (error) { providerFailure = error; res.statusCode = 500; res.end('fixture failure'); }
  });
});
provider.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
function waitChatEvent(message, expected) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({message});
    let buffer = '', matched = false;
    const req = http.request({hostname: '127.0.0.1', port, path: '/api/chat', method: 'POST', headers: {'X-Agent-Token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data)}}, res => {
      res.setEncoding('utf8'); res.on('error', error => { if (!matched) reject(error); });
      res.on('data', chunk => { buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop(); for (const line of lines) if (line.startsWith('data: ')) {
        const event = JSON.parse(line.slice(6)); if (event.type === expected) { matched = true; clearTimeout(timer); resolve(event); }
      }});
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error('Waiting for ' + expected)); }, 12000);
    req.on('error', error => { if (!matched) { clearTimeout(timer); reject(error); } }); req.end(data);
  });
}
function sessionFile(directory, record) {
  return path.join(directory, 'session-' + crypto.createHash('sha256').update(record.workspace + '\0' + record.baseUrl + '\0' + record.model).digest('hex').slice(0, 24) + '.json');
}
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, JSON.stringify(value)); }
async function main() {
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + provider.address().port + '/v1';
  const oldPackage = path.join(installs, 'pi-win7-web-0.3.0-x64');
  const oldState = path.join(oldPackage, '.state');
  const originalId = 'a'.repeat(24);
  const legacy = {sessionId: originalId, workspace, baseUrl, model: 'legacy-model', contextWindow: 100000, maxOutputTokens: 1536, permissionMode: 'workspace-write',
    messages: [{role: 'user', content: 'OLD VERSION HISTORY', timestamp: 1}], events: [], compaction: {enabled: true, reserveTokens: 16384, keepRecentTokens: 20000}};
  writeJson(path.join(oldState, 'config.json'), legacy);
  writeJson(sessionFile(oldState, legacy), legacy);
  let boot = await start(versionA);
  const state = path.join(profile, 'PiWin7Web');
  assert.strictEqual(boot.storage.directory, state);
  assert.strictEqual(boot.contextWindow, 100000); assert.strictEqual(boot.maxOutputTokens, 4096);
  assert((await ok('GET', '/api/sessions')).sessions.some(item => item.id === originalId));
  const configure = extra => ok('POST', '/api/settings', Object.assign({workspace, baseUrl, model: 'legacy-model', contextWindow: 100000}, extra));
  await configure({apiKey: key});
  await ok('POST', '/api/session/open', {id: originalId});
  await ok('POST', '/api/session/name', {name: 'Across upgrades'});
  let response = await request('POST', '/api/chat', {message: 'SAVE THIS TURN'}); assert.strictEqual(response.status, 200); assert(response.text.includes('PERSISTENT ANSWER'));
  const beforeRestart = await ok('GET', '/api/session');
  await stop();
  boot = await start(versionB);
  assert.strictEqual(boot.hasApiKey, true); assert.strictEqual(boot.sessionId, originalId);
  assert.deepStrictEqual((await ok('GET', '/api/session')).messages, beforeRestart.messages);
  await assert.rejects(start(versionA), /锁|使用|running|lock|占用/i);
  await configure({model: 'other-model'});
  assert((await ok('GET', '/api/sessions')).sessions.some(item => item.id === originalId && item.workspace === workspace));
  boot = await ok('POST', '/api/session/open', {id: originalId}); assert.strictEqual(boot.model, 'legacy-model'); assert(boot.hasApiKey);
  assert.strictEqual((await configure({baseUrl: baseUrl + '/other'})).hasApiKey, false);
  assert.strictEqual((await configure({})).hasApiKey, true);
  const external = path.join(temp, 'older-download');
  const importedId = 'b'.repeat(24);
  const imported = Object.assign({}, legacy, {sessionId: importedId, name: 'Recovered older conversation', messages: [{role: 'user', content: 'SECOND LEGACY HISTORY'}]});
  writeJson(path.join(external, '.state', 'config.json'), {workspace: 'bad', model: 'must-not-overwrite'});
  writeJson(sessionFile(path.join(external, '.state'), imported), imported);
  const importedResult = await ok('POST', '/api/storage/import', {path: external});
  assert(importedResult.importResult.importedSessions > 0);
  assert((await ok('GET', '/api/sessions')).sessions.some(item => item.title === imported.name));
  assert.strictEqual((await ok('GET', '/api/bootstrap')).model, 'legacy-model');
  const again = await ok('POST', '/api/storage/import', {path: external}); assert.strictEqual(again.importResult.importedSessions, 0);
  // Opening an archive from another model must retain that target model's
  // newer current conversation instead of overwriting its only record.
  await ok('POST', '/api/session/new', {});
  const displacedId = (await ok('GET', '/api/bootstrap')).sessionId;
  response = await request('POST', '/api/chat', {message: 'KEEP TARGET CURRENT'}); assert(response.text.includes('PERSISTENT ANSWER'));
  await configure({model: 'second-model'});
  response = await request('POST', '/api/chat', {message: 'OTHER MODEL CURRENT'}); assert(response.text.includes('PERSISTENT ANSWER'));
  await ok('POST', '/api/session/open', {id: originalId});
  assert((await ok('GET', '/api/sessions')).sessions.some(item => item.id === displacedId));
  await ok('POST', '/api/session/open', {id: displacedId});
  assert((await ok('GET', '/api/session')).messages.some(item => item.content === 'KEEP TARGET CURRENT'));
  await ok('POST', '/api/session/open', {id: originalId});
  // A moved/deleted legacy workspace never prevents reading the saved history.
  const missingRecord = Object.assign({}, legacy, {sessionId: 'c'.repeat(24), workspace: path.join(temp, 'removed-project'), name: 'Missing workspace history'});
  writeJson(path.join(external, '.state', 'archive-' + missingRecord.sessionId + '.json'), missingRecord);
  await ok('POST', '/api/storage/import', {path: external});
  const missingEntry = (await ok('GET', '/api/sessions')).sessions.find(item => item.title === missingRecord.name); assert(missingEntry);
  boot = await ok('POST', '/api/session/open', {id: missingEntry.id}); assert(boot.workspaceMissing);
  assert((await ok('GET', '/api/session')).messages.length > 0);
  assert.strictEqual((await request('POST', '/api/chat', {message: 'must choose workspace'})).status, 400);
  const missingHistory = (await ok('GET', '/api/session')).messages;
  boot = await ok('POST', '/api/workspace', {workspace}); assert(!boot.workspaceMissing);
  assert.notStrictEqual(boot.sessionId, missingEntry.id);
  assert.deepStrictEqual((await ok('GET', '/api/session')).messages, missingHistory);
  assert((await ok('GET', '/api/sessions')).sessions.some(item => item.id === originalId));
  response = await request('POST', '/api/chat', {message: 'CONTINUE IN MOVED WORKSPACE'}); assert(response.text.includes('PERSISTENT ANSWER'));
  await ok('POST', '/api/session/open', {id: originalId});
  await ok('POST', '/api/permissions', {mode: 'read-only'});
  await waitChatEvent('CRASH DURING TOOL', 'approval_request');
  await ok('POST', '/api/queue', {mode: 'followUp', message: 'UNDELIVERED DRAFT'});
  await stop();
  boot = await start(versionA); assert(boot.lastRunInterrupted); assert(boot.undeliveredMessages.some(item => item.message === 'UNDELIVERED DRAFT'));
  assert(!fs.existsSync(path.join(workspace, 'must-not-replay.txt')));
  response = await request('POST', '/api/chat', {message: 'CONTINUE AFTER TOOL CRASH'});
  assert(response.text.includes('PERSISTENT ANSWER'), response.text);
  assert(!fs.existsSync(path.join(workspace, 'must-not-replay.txt')));
  await waitChatEvent('CRASH DURING TEXT', 'text_delta');
  // text_delta is emitted immediately before the synchronous partial checkpoint.
  await ok('GET', '/api/bootstrap');
  await stop();
  boot = await start(versionB); assert(boot.lastRunInterrupted);
  const recovered = await ok('GET', '/api/session');
  assert(recovered.messages.some(item => item.content === 'PARTIAL ANSWER PRESERVED' && item.error));
  response = await request('POST', '/api/chat', {message: 'CONTINUE AFTER TEXT CRASH'}); assert(response.text.includes('PERSISTENT ANSWER'), response.text);
  await configure({}); await configure({});
  await stop();
  fs.writeFileSync(path.join(state, 'config.json'), '{truncated');
  boot = await start(versionA); assert.strictEqual(boot.model, 'legacy-model'); assert(boot.hasApiKey); assert(boot.storage.warnings.length > 0);
  await configure({clearApiKey: true}); await stop(); boot = await start(versionB); assert.strictEqual(boot.hasApiKey, false);
  for (const file of fs.readdirSync(state).filter(name => /^(config|session-|archive-)/.test(name))) assert(!fs.readFileSync(path.join(state, file), 'utf8').includes(key), 'Secret leaked outside credential store');
  if (providerFailure) throw providerFailure;
  console.log('Persistence integration passed on ' + process.version + ': cross-version profile, old-state imports, provider-bound key restart/clear, all-history navigation, lock, crash recovery and continued Pi tool conversations.');
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).then(async () => { await stop(); for (const proc of processes) proc.kill(); for (const socket of sockets) socket.destroy(); provider.close(); });
