'use strict';

// Exercise permission decisions and extensions through the real Pi loop on Node 12.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const root = path.resolve(__dirname, '..');
const tempRoot = path.join(root, '.test-tmp');
fs.mkdirSync(tempRoot, {recursive: true});
const temporary = fs.mkdtempSync(path.join(tempRoot, 'features-'));
const workspace = path.join(temporary, 'workspace');
const stateDirectory = path.join(temporary, 'state');
const outsideFile = path.join(temporary, 'outside.txt');
const insideFile = path.join(workspace, 'gate.txt');
const skillDirectory = path.join(workspace, '.agents', 'skills', 'test');
fs.mkdirSync(workspace);
fs.mkdirSync(stateDirectory);
fs.mkdirSync(skillDirectory, {recursive: true});
fs.writeFileSync(insideFile, 'original');
fs.writeFileSync(outsideFile, 'outside sentinel');
fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), '---\nname: test\ndescription: Feature test skill.\n---\nSKILL_BODY_ONLY_AFTER_READ\nReport this marker after loading.\n');
let port = 0;
let token = '';
let serverProcess;
let output = '';
let mockFailure;
let modelOverflowCount=0;
const received = [];
const summaryRequests = [];
let summaryMode = 'ok';
let summaryStarted;
const sockets = new Set();

function request(method, url, body, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers = options.token === false ? {} : {'X-Agent-Token': token};
    if (data !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({hostname: '127.0.0.1', port, path: url, method, headers}, res => {
      const chunks = [];
      res.on('data', value => chunks.push(value));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { if ((res.headers['content-type'] || '').includes('application/json')) json = JSON.parse(text); }
        catch (error) { reject(error); return; }
        resolve({status: res.statusCode, text, json});
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error(method + ' ' + url + ' timed out')));
    req.end(data);
  });
}

function startChat(message, route) {
  const events = [];
  const waiters = [];
  let failure;
  let ended = false;
  let finish;
  let rejectDone;
  const done = new Promise((resolve, reject) => { finish = resolve; rejectDone = reject; });
  // A waiter can fail before the caller awaits done; avoid an unhandled rejection.
  done.catch(() => {});
  const notify = () => {
    for (const waiter of waiters.slice()) {
      const event = events.find(waiter.match);
      if (event || failure || ended) {
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        if (event) waiter.resolve(event);
        else waiter.reject(failure || new Error('Chat ended before expected event. Events: ' + JSON.stringify(events)));
      }
    }
  };
  const fail = error => { if (ended) return; failure = error; ended = true; clearTimeout(timer); rejectDone(error); notify(); };
  const data = JSON.stringify(route === '/api/compact' ? {} : {message});
  const req = http.request({hostname: '127.0.0.1', port, path: route || '/api/chat', method: 'POST', headers: {
    'X-Agent-Token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
  }}, res => {
    let pending = '';
    res.setEncoding('utf8');
    res.on('data', value => {
      pending += value;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1);
        if (!line.startsWith('data: ')) continue;
        try { events.push(JSON.parse(line.slice(6))); notify(); }
        catch (error) { fail(error); req.destroy(); }
      }
    });
    res.on('error', fail);
    res.on('end', () => {
      if (ended) return;
      if (res.statusCode !== 200) { fail(new Error('Chat returned HTTP ' + res.statusCode + ': ' + pending)); return; }
      ended = true; clearTimeout(timer); finish(events); notify();
    });
  });
  const timer = setTimeout(() => { fail(new Error('Chat did not finish within 15 seconds')); req.destroy(); }, 15000);
  req.on('error', fail);
  req.end(data);
  return {events, done, waitFor(match) {
    return new Promise((resolve, reject) => {
      const waiter = {match: typeof match === 'string' ? event => event.type === match : match, resolve, reject};
      waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('Expected chat event not received: ' + String(match))); }, 8000);
      waiters.push(waiter); notify();
    });
  }};
}

function chunk(delta, finish) { return 'data: ' + JSON.stringify({choices: [{index: 0, delta: delta || {}, finish_reason: finish || null}]}) + '\n\n'; }
function sendTool(res, name, args, id) {
  res.end(chunk({tool_calls: [{index: 0, id, type: 'function', function: {name, arguments: JSON.stringify(args)}}]}) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n');
}
function sendText(res, text) { res.end(chunk({content: text || '检查完成。'}) + chunk({}, 'stop') + 'data: [DONE]\n\n'); }

const provider = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', value => chunks.push(value));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push(body);
      assert.strictEqual(body.model, 'feature-model');
      if (body.messages[0].content.includes('You are a context summarization assistant.')) {
        summaryRequests.push(body);
        assert(!body.tools || body.tools.length === 0, 'Summary requests must not execute tools');
        assert(body.messages[1].content.includes('<conversation>'));
        res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8'});
        if (summaryMode === 'fail') return res.end('data: {"error":{"message":"mock summary failure"}}\n\n');
        if (summaryMode === 'hang') { res.write(': summary pending\n\n'); if (summaryStarted) summaryStarted(); return; }
        return sendText(res, '## Goal\nCOMPACTED_CONTINUITY_MARKER: retain the user goal and earlier decisions.\n\n## Progress\nPrior conversation summarized.\n\n## Next Steps\nContinue the latest request.');
      }
      const latest = body.messages.map(item => item.role).lastIndexOf('user');
      const prompt = body.messages[latest].content;
      const results = body.messages.slice(latest + 1).filter(item => item.role === 'tool');
      if (prompt === 'PROVIDER OVERFLOW' && modelOverflowCount++ === 0) { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:{code:'context_length_exceeded',message:'maximum context length exceeded'}})); return; }
      res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8'});
      if (prompt.startsWith('WRITE:') && !results.length) return sendTool(res, 'write_file', {path: 'gate.txt', content: prompt.slice(6)}, 'write');
      if (prompt === 'OUTSIDE_READ' && !results.length) return sendTool(res, 'read_file', {path: outsideFile}, 'outside-read');
      if (prompt.startsWith('OUTSIDE_WRITE:') && !results.length) return sendTool(res, 'write_file', {path: outsideFile, content: prompt.slice(14)}, 'outside-write');
      if (prompt === 'FULL') {
        if (!results.length) return sendTool(res, 'read_file', {path: outsideFile}, 'full-read');
        if (results.length === 1) {
          assert(results[0].content.includes('outside sentinel'));
          return sendTool(res, 'write_file', {path: outsideFile, content: 'full access write'}, 'full-write');
        }
      }
      if (prompt === 'SHELL' && !results.length) return sendTool(res, 'run_process', {
        executable: process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe') : '/bin/sh',
        args: process.platform === 'win32' ? ['/c', 'exit', '0'] : ['-c', 'exit 0'],
      }, 'shell');
      if (prompt === 'SKILL') {
        if (!results.length) {
          assert(body.messages[0].content.includes('Feature test skill.'));
          assert(!body.messages[0].content.includes('SKILL_BODY_ONLY_AFTER_READ'));
          assert(body.tools.some(tool => tool.function.name === 'read_skill'));
          return sendTool(res, 'read_skill', {skill: 'test'}, 'skill');
        }
        assert(results[0].content.includes('SKILL_BODY_ONLY_AFTER_READ'));
      }
      if (prompt === 'SKILL_DISABLED') {
        assert(!body.tools.some(tool => tool.function.name === 'read_skill'));
        assert(!body.messages[0].content.includes('Feature test skill.'));
      }
      if (prompt === 'MCP' && !results.length) {
        const echo = body.tools.find(tool => /^mcp_demo_echo_/.test(tool.function.name));
        assert(echo, 'Configured MCP echo was not exposed to Pi');
        return sendTool(res, echo.function.name, {text: 'MCP 中文往返'}, 'mcp');
      }
      return sendText(res);
    } catch (error) { mockFailure = error; if (!res.headersSent) res.writeHead(500); res.end(); }
  });
});
provider.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });

async function startServer() {
  port = 0; output = '';
  await new Promise((resolve, reject) => {
    serverProcess = childProcess.spawn(process.execPath, [path.join(root, 'dist/server.cjs'), '--workspace', workspace, '--state-dir', stateDirectory, '--port', '0'], {
      cwd: root, env: Object.assign({}, process.env, {PI_API_KEY: '', PI_MODEL: '', PI_BASE_URL: '', PORT: ''}),
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => reject(new Error('Server did not start: ' + output)), 10000);
    serverProcess.stdout.on('data', data => {
      output += data.toString('utf8');
      const found = /Pi Win7 Web: http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (found) { port = Number(found[1]); clearTimeout(timer); resolve(); }
    });
    serverProcess.stderr.on('data', data => { output += data.toString('utf8'); });
    serverProcess.on('error', error => { clearTimeout(timer); reject(error); });
    serverProcess.on('exit', code => { clearTimeout(timer); if (!port) reject(new Error('Server exited ' + code + ': ' + output)); });
  });
}
async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { serverProcess.kill('SIGKILL'); resolve(); }, 3000);
    serverProcess.once('exit', () => { clearTimeout(timer); resolve(); }); serverProcess.kill();
  });
}
async function mode(value) {
  const response = await request('POST', '/api/permissions', {mode: value});
  assert.strictEqual(response.status, 200, response.text);
  assert.strictEqual(response.json.permissionMode, value);
}
function toolResult(events, name) {
  const event = events.find(item => item.type === 'tool_end' && (name ? item.name === name : true));
  assert(event, 'Missing tool result: ' + name + ' in ' + JSON.stringify(events));
  return event;
}
function assertFinished(events) {
  if (mockFailure) throw mockFailure;
  assert(events.some(event => event.type === 'done'), JSON.stringify(events));
}
async function decide(chat, decision, before) {
  const approval = await chat.waitFor('approval_request');
  if (before) await before(approval);
  const response = await request('POST', '/api/approval', {id: approval.id, decision});
  assert.strictEqual(response.status, 200, response.text);
  const events = await chat.done;
  assertFinished(events);
  return {approval, events};
}

async function main() {
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  await startServer();
  const first = await request('GET', '/api/bootstrap', undefined, {token: false});
  token = first.json.csrfToken;
  assert.strictEqual(first.json.permissionMode, 'workspace-write');
  assert.deepStrictEqual(first.json.compaction, {enabled: true, reserveTokens: 16000, keepRecentTokens: 19968});
  assert.deepStrictEqual(first.json.permissionModes.map(item => item.value), ['read-only', 'workspace-write', 'danger-full-access']);
  const baseUrl = 'http://127.0.0.1:' + provider.address().port + '/v1';
  const configure = async (contextWindow, maxOutputTokens) => {
    const response = await request('POST', '/api/settings', {workspace, model: 'feature-model', baseUrl, contextWindow, maxOutputTokens});
    assert.strictEqual(response.status, 200, response.text);
    assert.strictEqual(response.json.contextWindow, contextWindow);
    assert.strictEqual(response.json.maxOutputTokens, require('../dist/context.cjs').deriveContextBudget(contextWindow).maxOutputTokens);
    return response;
  };
  await configure(64000, 1536);
  assert.strictEqual((await request('POST', '/api/permissions', {mode: 'danger-full-access'}, {token: false})).status, 403);
  assert.strictEqual((await request('POST', '/api/permissions', {mode: 'invented'})).status, 400);
  let chat = startChat('WRITE:workspace direct');
  let events = await chat.done;
  assertFinished(events);
  assert(!events.some(item => item.type === 'approval_request'));
  assert.strictEqual(toolResult(events, 'write_file').isError, false);
  assert.strictEqual(fs.readFileSync(insideFile, 'utf8'), 'workspace direct');

  await mode('read-only');
  chat = startChat('WRITE:denied');
  let decision = await decide(chat, 'deny', async approval => {
    assert.strictEqual(fs.readFileSync(insideFile, 'utf8'), 'workspace direct');
    assert.strictEqual(approval.toolName, 'write_file');
    const pending = (await request('GET', '/api/bootstrap')).json;
    assert.strictEqual(pending.busy, true);
    assert(pending.pendingApprovals.some(item => item.id === approval.id));
    assert.strictEqual((await request('POST', '/api/permissions', {mode: 'danger-full-access'})).status, 409);
    assert.strictEqual((await request('POST', '/api/approval', {id: approval.id, decision: 'invalid'})).status, 400);
  });
  assert.strictEqual(toolResult(decision.events, 'write_file').isError, true);
  assert.strictEqual(fs.readFileSync(insideFile, 'utf8'), 'workspace direct');
  assert.strictEqual((await request('POST', '/api/approval', {id: decision.approval.id, decision: 'allow'})).status, 409);
  decision = await decide(startChat('WRITE:approved'), 'allow', () => assert.strictEqual(fs.readFileSync(insideFile, 'utf8'), 'workspace direct'));
  assert.strictEqual(toolResult(decision.events, 'write_file').isError, false);
  assert.strictEqual(fs.readFileSync(insideFile, 'utf8'), 'approved');
  chat = startChat('WRITE:cancelled');
  const cancelledApproval = await chat.waitFor('approval_request');
  assert.strictEqual((await request('POST', '/api/cancel', {})).status, 200);
  events = await chat.done;
  assertFinished(events);
  assert.strictEqual(fs.readFileSync(insideFile, 'utf8'), 'approved');
  const afterCancel = (await request('GET', '/api/bootstrap')).json;
  assert.strictEqual(afterCancel.busy, false);
  assert.deepStrictEqual(afterCancel.pendingApprovals, []);
  assert.strictEqual((await request('POST', '/api/approval', {id: cancelledApproval.id, decision: 'allow'})).status, 409);

  await mode('workspace-write');
  decision = await decide(startChat('OUTSIDE_READ'), 'deny');
  assert.strictEqual(toolResult(decision.events, 'read_file').isError, true);
  assert(!JSON.stringify(toolResult(decision.events, 'read_file').result).includes('outside sentinel'));
  decision = await decide(startChat('OUTSIDE_READ'), 'allow');
  assert.strictEqual(toolResult(decision.events, 'read_file').isError, false);
  assert(JSON.stringify(toolResult(decision.events, 'read_file').result).includes('outside sentinel'));
  decision = await decide(startChat('OUTSIDE_WRITE:approved outside'), 'allow', () => assert.strictEqual(fs.readFileSync(outsideFile, 'utf8'), 'outside sentinel'));
  assert.strictEqual(toolResult(decision.events, 'write_file').isError, false);
  assert.strictEqual(fs.readFileSync(outsideFile, 'utf8'), 'approved outside');
  fs.writeFileSync(outsideFile, 'outside sentinel');
  await mode('danger-full-access');
  events = await startChat('FULL').done;
  assertFinished(events);
  assert(!events.some(item => item.type === 'approval_request'));
  assert(events.filter(item => item.type === 'tool_end').every(item => item.isError === false));
  assert.strictEqual(fs.readFileSync(outsideFile, 'utf8'), 'full access write');
  events = await startChat('SHELL').done;
  assertFinished(events);
  assert.strictEqual(toolResult(events, 'run_process').isError, true);

  const initialExtensions = await request('GET', '/api/extensions');
  assert.strictEqual(initialExtensions.status, 200, initialExtensions.text);
  assert(initialExtensions.json.skills.some(skill => skill.name === 'test'));
  events = await startChat('SKILL').done;
  assertFinished(events);
  assert.strictEqual(toolResult(events, 'read_skill').isError, false);
  assert(JSON.stringify(toolResult(events, 'read_skill').result).includes('SKILL_BODY_ONLY_AFTER_READ'));
  const demo = {id: 'demo', transport: 'stdio', command: process.execPath, args: [path.join(root, 'examples', 'mcp-demo-server.cjs')], timeoutMs: 3000};
  const extensionSettings = await request('POST', '/api/extensions', {mcpServers: [demo], skillsEnabled: true, skillDirectories: []});
  assert.strictEqual(extensionSettings.status, 200, extensionSettings.text);
  assert((await request('GET', '/api/extensions')).json.mcpServers.some(server => server.id === 'demo'));
  const mcpTest = await request('POST', '/api/mcp/test', {id: 'demo'});
  assert.strictEqual(mcpTest.status, 200, mcpTest.text);
  assert.strictEqual(mcpTest.json.connected, true, mcpTest.text);
  assert(mcpTest.json.tools.some(tool => tool.name === 'echo'));
  await mode('workspace-write');
  decision = await decide(startChat('MCP'), 'deny');
  assert.strictEqual(toolResult(decision.events).isError, true);
  await mode('danger-full-access');
  events = await startChat('MCP').done;
  assertFinished(events);
  assert(!events.some(item => item.type === 'approval_request'));
  assert.strictEqual(toolResult(events).isError, false);
  assert(JSON.stringify(toolResult(events).result).includes('MCP 中文往返'));
  assert.strictEqual((await request('POST', '/api/extensions', {mcpServers: [], skillsEnabled: false, skillDirectories: []})).status, 200);
  assert.strictEqual((await request('POST', '/api/session/new', {})).status, 200);
  events = await startChat('SKILL_DISABLED').done;
  assertFinished(events);

  assert.strictEqual((await request('POST', '/api/session/new', {})).status, 200);
  const longOldPrompt = 'old context ' + 'x'.repeat(30000);
  events = await startChat(longOldPrompt).done;
  assertFinished(events);
  assert.strictEqual(received[received.length - 1].max_tokens, 4096);
  await configure(8192, 512);
  const summariesBefore = summaryRequests.length;
  events = await startChat('CONTEXT AFTER COMPACTION').done;
  assertFinished(events);
  const trimmedPayload = received[received.length - 1];
  assert.strictEqual(trimmedPayload.max_tokens, 512);
  assert(!trimmedPayload.messages.some(item => item.content === longOldPrompt));
  assert(trimmedPayload.messages.some(item => typeof item.content === 'string' && item.content.includes('COMPACTED_CONTINUITY_MARKER')), 'Continuation request lost the summary');
  assert(summaryRequests.length > summariesBefore, 'Automatic compaction never called the model');
  assert(summaryRequests.slice(summariesBefore).every(body => body.max_tokens <= 512));
  assert(events.some(item => item.type === 'compaction' && item.phase === 'done'));
  assert((await request('GET', '/api/session')).json.messages.some(item => item.content === longOldPrompt), 'Compaction erased saved history');
  const afterCompaction = (await request('GET', '/api/bootstrap')).json;
  const usage = afterCompaction.contextStats;
  assert.strictEqual(usage.estimated, true);
  assert.strictEqual(usage.droppedTurns, 0);
  assert(afterCompaction.lastCompaction.summarizedMessageCount >= 1);
  assert(usage.estimatedTokens <= usage.inputBudget);
  await configure(4096, 256);
  const callsBeforeOversized = received.length;
  events = await startChat('过大的本轮上下文'.repeat(2500)).done;
  assertFinished(events);
  assert(events.some(item => item.type === 'error' && /预算|上下文/.test(item.message)));
  assert.strictEqual(received.length, callsBeforeOversized, 'Oversized mandatory context reached provider');
  assert.strictEqual((await request('GET', '/api/bootstrap')).json.busy, false);
  await configure(64000, 1536);
  events = await startChat('RECOVER').done;
  assertFinished(events);
  assert(!events.some(item => item.type === 'error'));
  // Manual force uses the same real model summarization path and persists its checkpoint.
  const beforeManualCount = summaryRequests.length;
  events = await startChat('', '/api/compact').done;
  assertFinished(events);
  assert(summaryRequests.length > beforeManualCount);
  const savedCheckpoint = (await request('GET', '/api/bootstrap')).json.lastCompaction;
  assert(savedCheckpoint && savedCheckpoint.summarizedMessageCount > 0);
  summaryMode = 'fail';
  events = await startChat('', '/api/compact').done;
  assert(events.some(item => item.type === 'error'));
  assert.deepStrictEqual((await request('GET', '/api/bootstrap')).json.lastCompaction, savedCheckpoint);
  summaryMode = 'hang';
  const began = new Promise(resolve => { summaryStarted = resolve; });
  chat = startChat('', '/api/compact');
  await began;
  assert.strictEqual((await request('POST', '/api/cancel', {})).status, 200);
  events = await chat.done;
  assert(events.some(item => item.type === 'error'));
  assert.deepStrictEqual((await request('GET', '/api/bootstrap')).json.lastCompaction, savedCheckpoint);
  summaryMode = 'ok'; summaryStarted = null;
  await stopServer();
  await startServer();
  const restarted = (await request('GET', '/api/bootstrap', undefined, {token: false})).json;
  token = restarted.csrfToken;
  assert.deepStrictEqual(restarted.lastCompaction, savedCheckpoint);
  events = await startChat('RECOVER AFTER RESTART').done;
  assertFinished(events);
  assert(!events.some(item => item.type === 'error'));
  assert(received[received.length - 1].messages.some(item => typeof item.content === 'string' && item.content.includes('COMPACTED_CONTINUITY_MARKER')));
  if (mockFailure) throw mockFailure;
  // Project instructions and reusable prompt templates are visible and actually sent.
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'PROJECT_CONTEXT_SENTINEL\n');
  fs.mkdirSync(path.join(workspace, '.pi', 'prompts'), {recursive:true});
  fs.writeFileSync(path.join(workspace, '.pi', 'prompts', 'review.md'), '---\ndescription: Read a chosen file\n---\nReview $1 with $ARGUMENTS');
  const resources = await request('GET', '/api/pi/resources');
  assert.strictEqual(resources.status, 200, resources.text);
  assert(resources.json.contextFiles.some(file => file.path.endsWith('AGENTS.md')));
  assert(resources.json.prompts.some(prompt => prompt.name === 'review'));
  const template = await request('POST', '/api/pi/template', {name:'review',args:'"hello world.txt" precise'});
  assert.strictEqual(template.status,200,template.text);
  assert.strictEqual(template.json.text,'Review hello world.txt with hello world.txt precise');
  await startChat('RESOURCE TEST').done;
  assert(received[received.length-1].messages[0].content.includes('PROJECT_CONTEXT_SENTINEL'));
  const renamed = await request('POST','/api/session/name',{name:'中文命名'});
  assert.strictEqual(renamed.json.name,'中文命名');
  const beforeFork = (await request('GET','/api/session')).json;
  const jsonl = await request('GET','/api/session/export?format=jsonl');
  const exported = jsonl.text.trim().split('\n').map(JSON.parse);
  assert.strictEqual(exported[0].version,3);assert(exported.some(entry=>entry.type==='message'));
  const html = await request('GET','/api/session/export?format=html');assert(html.text.startsWith('<!doctype html>'));
  const tree = (await request('GET','/api/session/tree')).json.entries;
  assert(tree.some(entry=>entry.canFork));
  const forked = await request('POST','/api/session/fork',{});
  assert.strictEqual(forked.status,200,forked.text);assert.notStrictEqual(forked.json.sessionId,beforeFork.sessionId);
  assert.deepStrictEqual((await request('GET','/api/session')).json.messages,beforeFork.messages);
  assert((await request('GET','/api/sessions')).json.sessions.some(entry=>entry.id===beforeFork.sessionId && entry.title==='中文命名'));

  // While an actual tool waits for approval, queue both native Pi delivery modes.
  await mode('read-only');
  const queueChat=startChat('WRITE:queue gate');
  const gate=await queueChat.waitFor('approval_request');
  assert.strictEqual((await request('POST','/api/queue',{message:'STEER MESSAGE',mode:'steer'})).status,200);
  assert.strictEqual((await request('POST','/api/queue',{message:'FOLLOWUP MESSAGE',mode:'followUp'})).status,200);
  assert.strictEqual((await request('POST','/api/approval',{id:gate.id,decision:'deny'})).status,200);
  const queuedEvents=await queueChat.done;assertFinished(queuedEvents);
  assert.deepStrictEqual(queuedEvents.filter(event=>event.type==='user_message').map(event=>event.message),['STEER MESSAGE','FOLLOWUP MESSAGE']);
  assert.strictEqual((await request('POST','/api/queue',{message:'idle',mode:'steer'})).status,409);
  const queuedHistory=(await request('GET','/api/session')).json.messages;
  assert(queuedHistory.some(message=>message.content==='STEER MESSAGE'));
  assert(queuedHistory.some(message=>message.content==='FOLLOWUP MESSAGE'));
  // Canceled runs return queued text and persist it until the user restores/discards it.
  await mode('read-only');
  const abandonedQueue = startChat('WRITE:cancel queue');
  await abandonedQueue.waitFor('approval_request');
  assert.strictEqual((await request('POST','/api/queue',{message:'SAVE THIS QUEUED TEXT',mode:'followUp'})).status,200);
  await request('POST','/api/cancel',{});
  const abandonedEvents = await abandonedQueue.done;
  assert(abandonedEvents.some(event=>event.type==='queue_cancelled' && event.messages.some(item=>item.message==='SAVE THIS QUEUED TEXT')));
  const storedDraft = (await request('GET','/api/session')).json.undeliveredMessages.find(item=>item.message==='SAVE THIS QUEUED TEXT');
  assert(storedDraft);
  await stopServer(); await startServer();
  token=(await request('GET','/api/bootstrap',undefined,{token:false})).json.csrfToken;
  assert((await request('GET','/api/session')).json.undeliveredMessages.some(item=>item.id===storedDraft.id));
  assert.strictEqual((await request('POST','/api/queue/discard',{id:storedDraft.id})).status,200);
  assert(!(await request('GET','/api/session')).json.undeliveredMessages.some(item=>item.id===storedDraft.id));
  const presetView=(await request('GET','/api/pi/resources')).json;
  assert(presetView.builtinPresets.some(preset=>preset.value==='standard' && preset.available));
  assert(presetView.builtinPresets.some(preset=>preset.value==='ptc' && !preset.available));
  assert.strictEqual((await request('POST','/api/pi/resources',{preset:'ptc'})).status,400);
  assert.strictEqual((await request('POST','/api/pi/resources',{preset:'minimal'})).status,200);
  await startChat('MINIMAL PRESET').done;
  assert(received[received.length-1].messages[0].content.includes('You are a helpful software engineer assistant.'));
  assert.strictEqual((await request('POST','/api/pi/resources',{preset:'standard'})).status,200);
  const summariesBeforeOverflow=summaryRequests.length;
  const overflowEvents=await startChat('PROVIDER OVERFLOW').done;
  assertFinished(overflowEvents);
  assert(!overflowEvents.some(event=>event.type==='error'),JSON.stringify(overflowEvents));
  assert.strictEqual(modelOverflowCount,2,'Overflow must retry the original model request exactly once');
  assert(summaryRequests.length>summariesBeforeOverflow,'Provider overflow must force a real summary before retry');
  console.log('PASS features on ' + process.version + ': real Pi approvals, outside/full access, MCP, lazy Skills, context limits, real automatic/manual model summaries, immutable history, summary failure/cancel rollback and checkpoint restart recovery.');
}

main().catch(error => {
  console.error(error.stack || error);
  console.error('Server output:\n' + output);
  process.exitCode = 1;
}).then(async () => {
  await stopServer();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => provider.close(resolve));
  // Keep isolated fixtures under the workspace for inspection.
});
