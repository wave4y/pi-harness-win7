'use strict';

// Real Node 12 server and Pi loop; deterministic local model tests structure and
// persistence, not a real model's semantic summary quality or a real Win7 host.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const {deriveContextBudget, prepareContext, estimateContextTokens} = require('../dist/context.cjs');
const root = path.resolve(__dirname, '..');
const testRoot = path.join(root, '.test-tmp');
fs.mkdirSync(testRoot, {recursive: true});
const temporary = fs.mkdtempSync(path.join(testRoot, 'long-conversation-'));
const workspace = path.join(temporary, 'workspace');
const stateDir = path.join(temporary, 'state');
fs.mkdirSync(workspace); fs.mkdirSync(stateDir);
fs.writeFileSync(path.join(workspace, 'large.txt'), Array(90).fill('long conversation fixture '.repeat(18)).join('\n'));
fs.writeFileSync(path.join(workspace, 'small.txt'), Array(12).fill('上下文测试 Chinese and code '.repeat(6)).join('\n'));
fs.writeFileSync(path.join(workspace, 'decision.txt'), 'DECISION_KEEP: preserve complete tool groups and original history.');

let serverProcess, port, token, output = '', providerFailure;
let activeWindow = 100000, phase = 'large', currentPrompt = '';
const providerSockets = new Set();
const seenTurns = new Map();
const metrics = {large: {rounds: 0, requests: 0, summaries: 0, compactions: 0, maxInput: 0}, small: {rounds: 0, requests: 0, summaries: 0, compactions: 0, maxInput: 0}};
const goal = 'GOAL_KEEP: adapt Pi for Win7 and Chrome102.';
const decision = 'DECISION_KEEP: preserve complete tool groups and original history.';

function api(method, url, body, anonymous) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers = anonymous ? {} : {'X-Agent-Token': token};
    if (data !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({hostname: '127.0.0.1', port, path: url, method, headers}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({status: res.statusCode, text, json: (res.headers['content-type'] || '').includes('application/json') ? JSON.parse(text) : undefined});
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.setTimeout(20000, () => req.destroy(new Error(method + ' ' + url + ' timed out'))); req.end(data);
  });
}
async function checkedApi(method, route, body) {
  const response = await api(method, route, body);
  assert.strictEqual(response.status, 200, response.text); return response.json;
}
function frame(delta, reason) { return 'data: ' + JSON.stringify({choices: [{index: 0, delta: delta || {}, finish_reason: reason || null}]}) + '\n\n'; }
function sendText(res, text) { res.end(frame({content: text}) + frame({}, 'stop') + 'data: [DONE]\n\n'); }
function internalMessages(body) {
  return body.messages.filter(message => message.role !== 'system').map(message => {
    if (message.role === 'user') return {role: 'user', content: message.content};
    if (message.role === 'tool') return {role: 'toolResult', toolCallId: message.tool_call_id, content: [{type: 'text', text: message.content}]};
    const content = message.content ? [{type: 'text', text: message.content}] : [];
    for (const call of message.tool_calls || []) content.push({type: 'toolCall', id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments)});
    return {role: 'assistant', content, stopReason: message.tool_calls ? 'toolUse' : 'stop'};
  });
}
const provider = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.strictEqual(body.model, 'long-model');
      const system = body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
      const tools = (body.tools || []).map(tool => tool.function);
      // Independently check exactly what crossed the HTTP boundary, including
      // summary requests, schemas and paired multi-tool results.
      const prepared = prepareContext(internalMessages(body), system, tools, {contextWindow: activeWindow, maxOutputTokens: body.max_tokens}, {allowTruncation: false});
      metrics[phase].maxInput = Math.max(metrics[phase].maxInput, prepared.stats.estimatedTokens);
      assert.strictEqual(prepared.stats.droppedMessages, 0);
      res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8'});
      if (system.startsWith('You are a context summarization assistant.')) {
        metrics[phase].summaries++;
        assert.strictEqual(tools.length, 0);
        assert.strictEqual(body.max_tokens, deriveContextBudget(activeWindow).summaryMaxOutputTokens);
        const prompt = body.messages[1].content;
        assert(prompt.includes('<conversation>'));
        assert(prompt.includes(goal), 'Goal must be present in old history or the incremental checkpoint');
        assert(prompt.includes(decision), 'Earlier decision must reach the next checkpoint');
        return sendText(res, '## Goal\n' + goal + '\n\n## Key Decisions\n' + decision + '\n\n## Progress\nCompleted file reads remain recorded.\n\n## Next Steps\nContinue the exact latest user request.');
      }
      metrics[phase].requests++;
      assert.strictEqual(body.max_tokens, deriveContextBudget(activeWindow).maxOutputTokens);
      const users = body.messages.filter(message => message.role === 'user');
      assert.strictEqual(users[users.length - 1].content, currentPrompt, 'Latest request must remain verbatim after every compaction');
      assert(users.some(message => message.content.includes(goal)), 'Goal vanished from prepared conversation');
      assert(users.some(message => message.content.includes(decision)), 'Decision vanished from prepared conversation');
      const count = seenTurns.get(currentPrompt) || 0;
      seenTurns.set(currentPrompt, count + 1);
      if (count === 0) {
        const suffix = phase + '-' + metrics[phase].rounds;
        const calls = [phase === 'large' ? 'large.txt' : 'small.txt', 'decision.txt'].map((file, index) => ({index,
          id: 'read-' + suffix + '-' + index, type: 'function', function: {name: 'read_file', arguments: JSON.stringify({path: file, maxLines: 100})}}));
        return res.end(frame({tool_calls: calls}) + frame({}, 'tool_calls') + 'data: [DONE]\n\n');
      }
      assert.strictEqual(count, 1, 'A completed read must not be replayed after compaction');
      sendText(res, '完成第 ' + metrics[phase].rounds + ' 轮文件检查；按已有目标与约束继续。');
    } catch (error) {
      providerFailure = error;
      if (!res.headersSent) res.writeHead(400);
      res.end('data: {"error":{"message":"offline fixture assertion failed"}}\n\n');
    }
  });
});
provider.on('connection', socket => { providerSockets.add(socket); socket.on('close', () => providerSockets.delete(socket)); });

async function startServer() {
  port = 0; output = '';
  await new Promise((resolve, reject) => {
    serverProcess = childProcess.spawn(process.execPath, [path.join(root, 'dist/server.cjs'), '--workspace', workspace, '--state-dir', stateDir, '--port', '0'], {
      cwd: root, env: Object.assign({}, process.env, {PI_API_KEY: '', PI_MODEL: '', PI_BASE_URL: '', PORT: ''}),
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => reject(new Error('Server did not start: ' + output)), 15000);
    serverProcess.stdout.on('data', data => {
      output += data.toString('utf8');
      const match = /Pi Win7 Web: http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match && !port) { port = Number(match[1]); clearTimeout(timer); resolve(); }
    });
    serverProcess.stderr.on('data', data => { output += data.toString('utf8'); });
    serverProcess.on('error', error => { clearTimeout(timer); reject(error); });
    serverProcess.on('exit', code => { if (!port) { clearTimeout(timer); reject(new Error('Server exited ' + code + ': ' + output)); } });
  });
  const bootstrap = await api('GET', '/api/bootstrap', undefined, true);
  assert.strictEqual(bootstrap.status, 200); token = bootstrap.json.csrfToken; return bootstrap.json;
}
async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { serverProcess.kill('SIGKILL'); resolve(); }, 3000);
    serverProcess.once('exit', () => { clearTimeout(timer); resolve(); }); serverProcess.kill();
  });
}
function savedSession(id) {
  const candidates = fs.readdirSync(stateDir).filter(name => /^session-[0-9a-f]{24}\.json$/.test(name));
  for (const name of candidates) {
    const record = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
    if (record.sessionId === id) return record;
  }
  throw new Error('Current session is missing on disk');
}
async function turn(round) {
  metrics[phase].rounds = round;
  currentPrompt = 'TURN ' + phase + ' ' + round + ': 检查这轮文件并延续之前的决定。' + (round === 1 ? '\n' + goal + '\n' + decision : '');
  const response = await api('POST', '/api/chat', {message: currentPrompt});
  if (providerFailure) throw providerFailure;
  assert.strictEqual(response.status, 200, response.text);
  const events = response.text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert(!events.some(event => event.type === 'error' || event.type === 'compaction' && event.status === 'error'), JSON.stringify(events));
  assert(events.some(event => event.type === 'done'), JSON.stringify(events));
  const tools = events.filter(event => event.type === 'tool_end');
  assert.strictEqual(tools.length, 2, 'Every round must execute both real Pi file tools exactly once');
  assert(tools.every(event => !event.isError));
  metrics[phase].compactions += events.filter(event => event.type === 'compaction' && event.phase === 'done').length;
  const session = await checkedApi('GET', '/api/session');
  const record = savedSession(session.sessionId);
  assert.strictEqual(record.messages.filter(message => message.role === 'user').length, round, 'Raw user history must grow through repeated compactions');
  assert.strictEqual(record.messages.filter(message => message.role === 'toolResult').length, round * 2, 'Full raw tool history must remain on disk');
  assert.strictEqual(record.messages.length, round * 5);
  assert.strictEqual(session.sessionStats.turns, round);
  assert.strictEqual(session.sessionStats.steps, round * 2);
  assert.strictEqual(session.sessionStats.coverage.toolTimedCalls, round * 2);
  assert(session.sessionStats.summary.requests >= metrics[phase].compactions);
  assert.strictEqual(JSON.stringify(record.messages[0].content).includes(goal), true);
  assert(record.contextStats.estimatedTokens <= record.contextStats.inputBudget);
  assert.strictEqual(record.contextStats.droppedMessages, 0);
  return record;
}
async function runPhase(name, contextWindow, rounds) {
  phase = name; activeWindow = contextWindow;
  const config = await checkedApi('POST', '/api/settings', {workspace, model: 'long-model', baseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1', contextWindow,
    // Persisted pre-migration values must not override automatic budgets.
    maxOutputTokens: 999999, compaction: {enabled: true, reserveTokens: -1, keepRecentTokens: 0}});
  const budget = deriveContextBudget(contextWindow);
  assert.strictEqual(config.maxOutputTokens, budget.maxOutputTokens);
  assert.deepStrictEqual(config.compaction, {enabled: true, reserveTokens: budget.reserveTokens, keepRecentTokens: budget.keepRecentTokens});
  await checkedApi('POST', '/api/session/new', {});
  let record;
  for (let round = 1; round <= rounds; round++) {
    record = await turn(round);
    if (round === Math.floor(rounds / 2)) {
      assert(record.compactionState, 'Checkpoint should exist before restarting the long session');
      const previousState = JSON.stringify(record.compactionState);
      const previousMessages = JSON.stringify(record.messages);
      const previousStats = await checkedApi('GET', '/api/session/stats');
      await stopServer();
      const restored = await startServer();
      assert.strictEqual(restored.contextWindow, contextWindow);
      assert.strictEqual(restored.sessionId, record.sessionId);
      assert.deepStrictEqual(restored.sessionStats, previousStats);
      const saved = savedSession(record.sessionId);
      assert.strictEqual(JSON.stringify(saved.compactionState), previousState, 'Checkpoint must survive restart unchanged');
      assert.strictEqual(JSON.stringify(saved.messages), previousMessages, 'All history must survive restart unchanged');
    }
  }
  assert(metrics[name].compactions >= 3, 'Long conversation must trigger at least three independent compaction cycles: ' + JSON.stringify(metrics[name]));
  assert(metrics[name].summaries >= metrics[name].compactions);
  assert.strictEqual(metrics[name].requests, rounds * 2);
  assert(estimateContextTokens(record.messages, '', []) > contextWindow, 'Raw history must exceed the configured window');
  assert(record.compactionState.summarizedMessageCount > 5);
  return record;
}
async function main() {
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  await startServer();
  await runPhase('large', 100000, 24);
  await checkedApi('POST', '/api/pi/resources', {preset: 'minimal'});
  await runPhase('small', 8192, 24);
  console.log('PASS long conversation: 48 rounds, 96 real Pi file calls, complete tool groups, bounded summary/model requests, immutable raw history, and two restarts. ' + JSON.stringify(metrics));
}
main().catch(error => { console.error(error.stack || error); if (output) console.error(output); process.exitCode = 1; }).then(async () => {
  await stopServer(); for (const socket of providerSockets) socket.destroy(); await new Promise(resolve => provider.close(resolve));
});
