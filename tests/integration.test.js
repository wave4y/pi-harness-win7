'use strict';

// Exercise the actual bundled server and Pi loop, including provider HTTP and
// disk effects. Compatible with the portable Node 12 runtime; no test framework.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const root = path.resolve(__dirname, '..');
const tempRoot = path.join(root, '.test-tmp');
fs.mkdirSync(tempRoot, { recursive: true });
const temporary = fs.mkdtempSync(path.join(tempRoot, 'integration-'));
const workspace = path.join(temporary, 'workspace');
const otherWorkspace = path.join(temporary, '另一个项目');
const stateDirectory = path.join(temporary, 'state');
fs.mkdirSync(workspace);
fs.mkdirSync(otherWorkspace);
fs.mkdirSync(path.join(otherWorkspace, '子文件夹'));
fs.writeFileSync(path.join(otherWorkspace, '中文.txt'), '另一个项目的文件');
fs.mkdirSync(stateDirectory);
fs.writeFileSync(path.join(temporary, 'outside.txt'), 'outside sentinel');
const secret = 'integration-credential-store-only-' + process.pid;
let port = 0;
let token = '';
let serverProcess;
let output = '';
let resolveHung;
let mockFailure;
const received = [];
const sockets = new Set();

function request(method, url, body, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers = Object.assign({}, options.token === false ? {} : { 'X-Agent-Token': token }, options.headers || {});
    if (data !== undefined) {
      headers['Content-Type'] = options.contentType || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        if ((res.headers['content-type'] || '').includes('application/json')) {
          try { json = JSON.parse(text); } catch (error) { reject(error); return; }
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(7000, () => req.destroy(new Error(method + ' ' + url + ' timed out')));
    if (data !== undefined) req.write(data);
    req.end();
  });
}

function parseEvents(response) {
  assert.strictEqual(response.status, 200, response.text);
  assert((response.headers['content-type'] || '').includes('text/event-stream'));
  return response.text.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
}

function chunk(delta, finish) {
  return 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: delta || {}, finish_reason: finish || null }] }) + '\r\n\r\n';
}

function toolFrames(name, args, id, finish) {
  const raw = JSON.stringify(args);
  const cut = Math.floor(raw.length / 2);
  return chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: raw.slice(0, cut) } }] }) +
    chunk({ tool_calls: [{ index: 0, function: { arguments: raw.slice(cut) } }] }) +
    (finish === false ? '' : chunk({}, finish || 'tool_calls') + 'data: [DONE]\r\n\r\n');
}

function fragmentedResponse(res, text) {
  // Deliberately split UTF-8 bytes inside Chinese characters and SSE delimiters.
  const bytes = Buffer.from(text);
  let offset = 0;
  let index = 0;
  const sizes = [1, 2, 7, 11, 3, 17];
  function writeNext() {
    if (res.destroyed) return;
    if (offset >= bytes.length) { res.end(); return; }
    const end = Math.min(bytes.length, offset + sizes[index++ % sizes.length]);
    res.write(bytes.slice(offset, end));
    offset = end;
    setImmediate(writeNext);
  }
  writeNext();
}

const provider = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', value => chunks.push(value));
  req.on('end', () => {
    try {
      assert.strictEqual(req.url, '/v1/chat/completions');
      assert.strictEqual(req.method, 'POST');
      assert.strictEqual(req.headers.authorization, 'Bearer ' + secret);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push(body);
      assert.strictEqual(body.model, 'integration-model');
      assert.strictEqual(body.stream, true);
      assert(body.tools.some(tool => tool.function.name === 'read_file'));
      const lastUserIndex = body.messages.map(message => message.role).lastIndexOf('user');
      const prompt = body.messages[lastUserIndex].content;
      const results = body.messages.slice(lastUserIndex + 1).filter(message => message.role === 'tool');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      if (prompt === 'TOOLS') {
        if (results.length === 0) {
          fragmentedResponse(res, toolFrames('write_file', { path: '中文.txt', content: '第一行\r\n原内容\r\n' }, 'call-write'));
        } else if (results.length === 1) {
          assert.strictEqual(results[0].tool_call_id, 'call-write');
          assert(body.messages.some(message => message.tool_calls && message.tool_calls[0].id === 'call-write'));
          fragmentedResponse(res, toolFrames('read_file', { path: '中文.txt' }, 'call-read'));
        } else if (results.length === 2) {
          assert(results[1].content.includes('原内容'));
          fragmentedResponse(res, toolFrames('edit_file', { path: '中文.txt', oldText: '原内容', newText: '已修改' }, 'call-edit'));
        } else {
          assert.strictEqual(results.length, 3);
          assert.strictEqual(results[2].tool_call_id, 'call-edit');
          fragmentedResponse(res, chunk({ content: '完成：' }) + chunk({ content: '中文文件已修改。' }) + chunk({}, 'stop') + 'data: [DONE]\r\n\r\n');
        }
      } else if (prompt === 'HANG') {
        res.write(': connected\n\n');
        if (resolveHung) resolveHung();
      } else if (prompt === 'MALFORMED') {
        fragmentedResponse(res, 'data: {not-json}\n\n');
      } else if (prompt === 'TRUNCATED') {
        fragmentedResponse(res, toolFrames('write_file', { path: 'must-not-exist.txt', content: 'incomplete' }, 'call-truncated', false));
      } else if (prompt === 'LENGTH') {
        fragmentedResponse(res, toolFrames('write_file', { path: 'must-not-exist.txt', content: 'length-limited' }, 'call-length', 'length'));
      } else {
        fragmentedResponse(res, chunk({ content: '恢复正常。' }) + chunk({}, 'stop') + 'data: [DONE]\r\n\r\n');
      }
    } catch (error) {
      mockFailure = error;
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
});
provider.on('connection', socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

function startServer() {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, { PI_API_KEY: '', PI_BASE_URL: '', PI_MODEL: '', PORT: '' });
    serverProcess = childProcess.spawn(process.execPath, [path.join(root, 'dist/server.cjs'), '--workspace', workspace, '--state-dir', stateDirectory, '--port', '0'], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
    });
    const timer = setTimeout(() => reject(new Error('Server did not start: ' + output)), 10000);
    function onData(data) {
      output += data.toString('utf8');
      const found = /Pi Win7 Web: http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (found) { port = Number(found[1]); clearTimeout(timer); resolve(); }
    }
    serverProcess.stdout.on('data', onData);
    serverProcess.stderr.on('data', data => { output += data.toString('utf8'); });
    serverProcess.on('error', error => { clearTimeout(timer); reject(error); });
    serverProcess.on('exit', code => { clearTimeout(timer); if (!port) reject(new Error('Server exited ' + code + ': ' + output)); });
  });
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { serverProcess.kill('SIGKILL'); resolve(); }, 3000);
    serverProcess.once('exit', () => { clearTimeout(timer); resolve(); });
    serverProcess.kill();
  });
}

async function main() {
  // Outside the former HTTP hostname whitelist; requests stay on the test machine.
  await new Promise(resolve => provider.listen(0, '127.0.0.2', resolve));
  const baseUrl = 'http://127.0.0.2:' + provider.address().port + '/v1';
  await startServer();
  const initial = await request('GET', '/api/bootstrap', undefined, { token: false });
  assert.strictEqual(initial.status, 200);
  assert(initial.json.engine.includes('Pi') && initial.json.engine.includes('0.51.6'));
  token = initial.json.csrfToken;
  assert(/^[a-f0-9]{64}$/.test(token));
  assert.strictEqual((await request('GET', '/')).status, 200);
  assert.strictEqual((await request('GET', '/api/session', undefined, { token: false })).status, 403);
  assert.strictEqual((await request('GET', '/api/folders?path=' + encodeURIComponent(temporary), undefined, { token: false })).status, 403);
  assert.strictEqual((await request('GET', '/api/sessions', undefined, { token: false })).status, 403);
  assert.strictEqual((await request('POST', '/api/workspace', { workspace: otherWorkspace }, { token: false })).status, 403);
  assert.strictEqual((await request('POST', '/api/session/open', { id: initial.json.sessionId }, { token: false })).status, 403);
  assert.strictEqual((await request('GET', '/api/session', undefined, { headers: { 'X-Agent-Token': 'invalid' } })).status, 403);
  assert.strictEqual((await request('GET', '/api/bootstrap', undefined, { headers: { Host: 'untrusted.example' } })).status, 403);
  assert.strictEqual((await request('GET', '/api/bootstrap', undefined, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.strictEqual((await request('GET', '/api/bootstrap', undefined, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.strictEqual((await request('GET', '/api/session', undefined, { headers: { Origin: 'http://127.0.0.1:' + port } })).status, 200);
  for (const filename of ['../outside.txt', '..\\outside.txt', 'file.txt:secret', 'NUL']) {
    assert.strictEqual((await request('GET', '/api/file?path=' + encodeURIComponent(filename))).status, 400);
    assert.strictEqual((await request('PUT', '/api/file', { path: filename, content: 'blocked' })).status, 400);
  }
  assert.strictEqual(fs.readFileSync(path.join(temporary, 'outside.txt'), 'utf8'), 'outside sentinel');
  assert.strictEqual((await request('GET', '/%2e%2e%2fpackage.json')).status, 404);
  const groupedAsset = await request('GET', '/session-groups.js', undefined, { token: false });
  assert.strictEqual(groupedAsset.status, 200);
  assert(groupedAsset.headers['content-type'].includes('javascript'));
  assert(groupedAsset.text.includes('SessionGroups'));
  const statsStyle = await request('GET', '/session-stats.css', undefined, { token: false });
  assert.strictEqual(statsStyle.status, 200); assert(statsStyle.headers['content-type'].includes('css'));

  assert.strictEqual((await request('POST', '/api/settings', { workspace, model: 'integration-model', baseUrl, apiKey: secret }, { contentType: 'text/plain' })).status, 415);
  const settings = await request('POST', '/api/settings', { workspace, model: 'integration-model', baseUrl, apiKey: secret });
  assert.strictEqual(settings.status, 200, settings.text);
  assert.strictEqual(settings.json.hasApiKey, true);
  assert(!settings.text.includes(secret));

  const toolEvents = parseEvents(await request('POST', '/api/chat', { message: 'TOOLS' }));
  if (mockFailure) throw mockFailure;
  assert.deepStrictEqual(toolEvents.filter(event => event.type === 'tool_end').map(event => event.name), ['write_file', 'read_file', 'edit_file']);
  assert(toolEvents.filter(event => event.type === 'tool_end').every(event => event.isError === false));
  assert.strictEqual(toolEvents.filter(event => event.type === 'text_delta').map(event => event.delta).join(''), '完成：中文文件已修改。');
  assert.strictEqual(toolEvents[toolEvents.length - 1].type, 'done');
  assert.strictEqual(toolEvents[toolEvents.length - 1].aborted, false);
  assert.strictEqual(received.length, 4);
  assert.strictEqual(fs.readFileSync(path.join(workspace, '中文.txt'), 'utf8'), '第一行\r\n已修改\r\n');
  const fileUrl = '/api/file?path=' + encodeURIComponent('中文.txt');
  const opened = await request('GET', fileUrl);
  assert.strictEqual(opened.json.content, '第一行\r\n已修改\r\n');
  fs.writeFileSync(path.join(workspace, '中文.txt'), '另一个程序修改');
  const conflict = await request('PUT', '/api/file', { path: '中文.txt', content: 'must not overwrite', originalContent: opened.json.content });
  assert.strictEqual(conflict.status, 409);
  assert.strictEqual(fs.readFileSync(path.join(workspace, '中文.txt'), 'utf8'), '另一个程序修改');
  assert.strictEqual((await request('PUT', '/api/file', { path: '中文.txt', content: '网页保存成功', originalContent: '另一个程序修改' })).status, 200);
  assert.strictEqual(fs.readFileSync(path.join(workspace, '中文.txt'), 'utf8'), '网页保存成功');
  const session = await request('GET', '/api/session');
  assert(session.json.messages.some(message => message.content === '完成：中文文件已修改。'));

  // A folder chooser may browse outside the active workspace without granting
  // the Agent file access or changing the selected project when it is canceled.
  const beforeBrowsing = (await request('GET', '/api/bootstrap')).json;
  const savedConfigBeforeBrowsing = fs.readFileSync(path.join(stateDirectory, 'config.json'), 'utf8');
  const parentFolders = await request('GET', '/api/folders?path=' + encodeURIComponent(temporary));
  assert.strictEqual(parentFolders.status, 200, parentFolders.text);
  assert.strictEqual(parentFolders.json.path, temporary);
  assert(parentFolders.json.entries.some(entry => entry.path === otherWorkspace && entry.name === '另一个项目'));
  assert(!parentFolders.json.entries.some(entry => entry.name === 'outside.txt'));
  const otherFolders = await request('GET', '/api/folders?path=' + encodeURIComponent(otherWorkspace));
  assert.strictEqual(otherFolders.status, 200, otherFolders.text);
  assert.strictEqual(otherFolders.json.parent, temporary);
  assert.deepStrictEqual(otherFolders.json.entries.map(entry => entry.name), ['子文件夹']);
  for (const invalidPath of ['.', '..', 'relative/folder', path.join(temporary, 'outside.txt')]) {
    assert.strictEqual((await request('GET', '/api/folders?path=' + encodeURIComponent(invalidPath))).status, 400);
  }
  assert.strictEqual((await request('GET', '/api/folders?path=' + encodeURIComponent(path.join(temporary, 'missing-folder')))).status, 404);
  assert.deepStrictEqual((await request('GET', '/api/bootstrap')).json, beforeBrowsing);
  assert.deepStrictEqual((await request('GET', '/api/session')).json, session.json);
  assert.strictEqual(fs.readFileSync(path.join(stateDirectory, 'config.json'), 'utf8'), savedConfigBeforeBrowsing);
  assert.strictEqual((await request('GET', '/api/file?path=' + encodeURIComponent(path.join(otherWorkspace, '中文.txt')))).status, 400);

  // Starting a session archives its transcript and tool results; reopening it
  // must restore those results and keep the history picker free of duplicates.
  const originalSessionId = session.json.sessionId;
  const firstHistory = await request('GET', '/api/sessions');
  assert.strictEqual(firstHistory.status, 200, firstHistory.text);
  assert.deepStrictEqual(firstHistory.json.sessions.map(item => [item.id, item.title, item.active]), [[originalSessionId, 'TOOLS', true]]);
  assert(Number.isFinite(firstHistory.json.sessions[0].updatedAt));
  const freshSession = await request('POST', '/api/session/new', {});
  assert.strictEqual(freshSession.status, 200, freshSession.text);
  assert(/^[a-f0-9]{24}$/.test(freshSession.json.sessionId));
  assert.notStrictEqual(freshSession.json.sessionId, originalSessionId);
  assert.deepStrictEqual((await request('GET', '/api/session')).json.messages, []);
  const archivedHistory = (await request('GET', '/api/sessions')).json.sessions;
  assert(archivedHistory.some(item => item.id === originalSessionId && item.title === 'TOOLS' && item.active === false));
  assert(archivedHistory.some(item => item.id === freshSession.json.sessionId && item.active === true));
  const secondChat = parseEvents(await request('POST', '/api/chat', { message: 'SECOND SESSION' }));
  assert.strictEqual(secondChat[secondChat.length - 1].aborted, false);
  const secondSession = (await request('GET', '/api/session')).json;
  for (const invalidId of ['../outside', originalSessionId.toUpperCase(), 'a'.repeat(23), 'a'.repeat(25), 123]) {
    assert.strictEqual((await request('POST', '/api/session/open', { id: invalidId })).status, 400);
  }
  assert.strictEqual((await request('POST', '/api/session/open', { id: '0'.repeat(24) })).status, 404);
  assert.strictEqual((await request('POST', '/api/session/open', { id: originalSessionId })).status, 200);
  assert.deepStrictEqual((await request('GET', '/api/session')).json, session.json);
  const reopenedHistory = (await request('GET', '/api/sessions')).json.sessions;
  assert.strictEqual(reopenedHistory.filter(item => item.id === originalSessionId).length, 1);
  assert.strictEqual(reopenedHistory.filter(item => item.active).length, 1);
  assert(reopenedHistory.some(item => item.id === secondSession.sessionId && item.title === 'SECOND SESSION' && item.active === false));
  assert.strictEqual((await request('POST', '/api/session/open', { id: secondSession.sessionId })).status, 200);
  assert.deepStrictEqual((await request('GET', '/api/session')).json, secondSession);
  assert.strictEqual((await request('POST', '/api/session/open', { id: originalSessionId })).status, 200);

  // Only explicit confirmation switches the project. The same relative path
  // must then refer to the new project's file, with independent session state.
  const switched = await request('POST', '/api/workspace', { workspace: otherWorkspace });
  assert.strictEqual(switched.status, 200, switched.text);
  assert.strictEqual(switched.json.workspace, otherWorkspace);
  assert.strictEqual(switched.json.model, 'integration-model');
  assert.strictEqual(switched.json.hasApiKey, true);
  assert.strictEqual((await request('GET', '/api/bootstrap')).json.workspace, otherWorkspace);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(stateDirectory, 'config.json'), 'utf8')).workspace, otherWorkspace);
  const otherSession = (await request('GET', '/api/session')).json;
  assert.notStrictEqual(otherSession.sessionId, originalSessionId);
  assert.deepStrictEqual(otherSession.messages, []);
  assert.strictEqual((await request('GET', fileUrl)).json.content, '另一个项目的文件');
  assert.strictEqual((await request('PUT', '/api/file', { path: '中文.txt', content: '另一个项目已保存', originalContent: '另一个项目的文件' })).status, 200);
  assert.strictEqual(fs.readFileSync(path.join(workspace, '中文.txt'), 'utf8'), '网页保存成功');
  assert.strictEqual(fs.readFileSync(path.join(otherWorkspace, '中文.txt'), 'utf8'), '另一个项目已保存');
  assert((await request('GET', '/api/sessions')).json.sessions.some(item => item.id === originalSessionId && item.workspace === workspace));
  for (const invalidWorkspace of ['relative/project', path.join(temporary, 'outside.txt'), path.join(temporary, 'missing-project')]) {
    assert.strictEqual((await request('POST', '/api/workspace', { workspace: invalidWorkspace })).status, 400);
  }
  assert.strictEqual((await request('GET', '/api/bootstrap')).json.workspace, otherWorkspace);
  assert.deepStrictEqual((await request('GET', '/api/session')).json, otherSession);
  assert.strictEqual((await request('POST', '/api/workspace', { workspace })).status, 200);
  assert.strictEqual((await request('GET', '/api/bootstrap')).json.workspace, workspace);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(stateDirectory, 'config.json'), 'utf8')).workspace, workspace);
  assert.deepStrictEqual((await request('GET', '/api/session')).json, session.json);
  assert.strictEqual((await request('GET', fileUrl)).json.content, '网页保存成功');
  const changedModel = await request('POST', '/api/settings', { workspace, model: 'different-model', baseUrl });
  assert.strictEqual(changedModel.status, 200, changedModel.text);
  assert((await request('GET', '/api/sessions')).json.sessions.some(item => item.id === originalSessionId));
  assert.strictEqual((await request('POST', '/api/session/open', { id: originalSessionId })).status, 200);
  assert.strictEqual((await request('GET', '/api/bootstrap')).json.model, 'integration-model');
  assert.strictEqual((await request('POST', '/api/settings', { workspace, model: 'integration-model', baseUrl })).status, 200);
  assert.deepStrictEqual((await request('GET', '/api/session')).json, session.json);

  const hungStarted = new Promise(resolve => { resolveHung = resolve; });
  const hungChat = request('POST', '/api/chat', { message: 'HANG' });
  const timeout = new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Hung mock request did not arrive')), 5000); timer.unref(); });
  await Promise.race([hungStarted, timeout]);
  assert.strictEqual((await request('GET', '/api/bootstrap')).json.busy, true);
  assert.strictEqual((await request('PUT', '/api/file', { path: '中文.txt', content: 'blocked while busy' })).status, 409);
  assert.strictEqual((await request('POST', '/api/workspace', { workspace: otherWorkspace })).status, 409);
  assert.strictEqual((await request('POST', '/api/session/open', { id: secondSession.sessionId })).status, 409);
  assert.strictEqual((await request('POST', '/api/session/new', {})).status, 409);
  assert.strictEqual((await request('POST', '/api/cancel', {})).status, 200);
  const cancelled = parseEvents(await hungChat);
  assert(cancelled.some(event => event.type === 'error'));
  assert.strictEqual(cancelled[cancelled.length - 1].aborted, true);
  assert.strictEqual((await request('GET', '/api/bootstrap')).json.busy, false);
  const recovery = parseEvents(await request('POST', '/api/chat', { message: 'RECOVER' }));
  assert.strictEqual(recovery.filter(event => event.type === 'text_delta').map(event => event.delta).join(''), '恢复正常。');
  for (const prompt of ['MALFORMED', 'TRUNCATED', 'LENGTH']) {
    const events = parseEvents(await request('POST', '/api/chat', { message: prompt }));
    assert(events.some(event => event.type === 'error'), prompt + ' must surface an error');
    assert.strictEqual(events[events.length - 1].type, 'done');
    assert.strictEqual(events[events.length - 1].aborted, true);
    assert.strictEqual((await request('GET', '/api/bootstrap')).json.busy, false);
    assert.strictEqual(fs.existsSync(path.join(workspace, 'must-not-exist.txt')), false);
  }
  if (mockFailure) throw mockFailure;
  for (const filename of fs.readdirSync(stateDirectory)) {
    if (/^credentials\.json(?:\.bak)?$/.test(filename)) continue;
    assert(!fs.readFileSync(path.join(stateDirectory, filename), 'utf8').includes(secret), 'API key persisted in ' + filename);
  }
  const savedSessions = fs.readdirSync(stateDirectory).filter(filename => filename.startsWith('session-'))
    .map(filename => JSON.parse(fs.readFileSync(path.join(stateDirectory, filename), 'utf8')));
  assert(savedSessions.some(savedSession => savedSession.messages.some(message => message.role === 'toolResult')));
  assert(!output.includes(secret), 'API key was printed');
  console.log('Integration passed on ' + process.version + ': real Pi tool loop, fragmented Chinese SSE, auth/origin/paths, save conflict, read-only folder browsing, workspace isolation, session history/reopen, cancellation and malformed/truncated streams.');
}

main().catch(error => {
  console.error(error.stack || error);
  console.error('Server output:\n' + output);
  process.exitCode = 1;
}).then(async () => {
  await stopServer();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => provider.close(resolve));
  // Preserve this isolated fixture for inspection; no recursive deletion of user paths.
});
