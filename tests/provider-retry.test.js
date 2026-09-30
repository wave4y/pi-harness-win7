'use strict';
const assert = require('assert');
const http = require('http');
const {createModel, streamCompatible, validateBaseUrl} = require('../dist/provider.cjs');
const secret = 'provider-error-body-secret-never-echo';
let mode = '';
let attempts = 0;
let captures = [];
let requestPaths = [];
const sockets = new Set();
function frame(delta, finish) { return 'data: ' + JSON.stringify({choices: [{index: 0, delta: delta || {}, finish_reason: finish || null}]}) + '\n\n'; }
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', value => chunks.push(value));
  req.on('end', () => {
    attempts++;
    captures.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    requestPaths.push(req.url);
    let status = 0;
    if (mode === 'transient' && attempts <= 3) status = [429, 502, 504][attempts - 1];
    if (mode === 'exhaust' || mode === 'cancel') status = 503;
    if (mode === 'overflow-always' || mode === 'overflow-once' && attempts === 1) status = 400;
    if (mode === 'auth') status = 401;
    if (status) {
      res.writeHead(status, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: {code: status === 400 ? 'context_length_exceeded' : 'temporary_failure', message: 'Maximum context length exceeded ' + secret}}));
      return;
    }
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    if (mode === 'incomplete') return res.end(frame({}));
    if (mode === 'malformed') return res.end('data: {bad json}\n\n');
    if (mode === 'partial-text') return res.end(frame({content: 'Already visible'}) + 'data: {"error":{"code":503}}\n\n');
    if (mode === 'partial-tool') return res.end(frame({tool_calls: [{index: 0, id: 'call', type: 'function', function: {name: 'write_file', arguments: '{"path":"unfinished'}}]}));
    res.end(frame({content: 'Success'}) + frame({}, 'stop') + 'data: [DONE]\n\n');
  });
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
function abortController() {
  const listeners = new Set();
  const signal = {aborted: false, addEventListener(_type, listener) { listeners.add(listener); }, removeEventListener(_type, listener) { listeners.delete(listener); }};
  return {signal, abort() { signal.aborted = true; for (const listener of Array.from(listeners)) listener(); }};
}
function reset(value) { mode = value; attempts = 0; captures = []; requestPaths = []; }
async function fastBackoff(callback) {
  const original = global.setTimeout;
  // Preserve the production 2/4/8-second schedule in notifications while advancing
  // only those test timers quickly. Cancellation below uses real wall-clock delay.
  global.setTimeout = (fn, ms, ...args) => original(fn, [2000, 4000, 8000].includes(ms) ? 1 : ms, ...args);
  try { return await callback(); } finally { global.setTimeout = original; }
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const model = createModel('retry-test', 'http://127.0.0.1:' + server.address().port + '/v1', {contextWindow: 8192, maxOutputTokens: 256});
  assert.strictEqual(model.maxTokens, 512, 'Normal requests ignore legacy configured output and derive it from the window');
  const summaryModel = createModel(model.id, model.baseUrl, {contextWindow: 100000, maxOutputTokens: 999999}, {maxOutputTokens: 3200});
  assert.strictEqual(summaryModel.maxTokens, 3200, 'Trusted summary output must survive model creation');
  assert.throws(() => createModel(model.id, model.baseUrl, {contextWindow: 8192}, {maxOutputTokens: 513}), /内部请求/);
  const originalContext = {systemPrompt: 'System', tools: [], messages: [{role: 'user', content: 'old task'}, {role: 'assistant', content: [{type: 'text', text: 'earlier response'}], stopReason: 'stop'}, {role: 'user', content: 'latest request'}]};
  const httpBases = [
    ['http://MODEL.EXAMPLE:80/v1/', 'http://model.example/v1'],
    ['http://192.168.1.2:8080/api/v1///', 'http://192.168.1.2:8080/api/v1'],
    ['http://10.0.0.8:8000/', 'http://10.0.0.8:8000'],
  ];
  for (const invalid of ['ftp://model.example/v1', 'http://user:pass@model.example/v1', 'https://user@model.example/v1', 'http://model.example/v1?key=fixture', 'https://model.example/v1#fragment']) {
    assert.throws(() => validateBaseUrl(invalid), 'Unsafe URL components must remain rejected');
  }
  assert.strictEqual(validateBaseUrl('https://MODEL.EXAMPLE:443/v1/'), 'https://model.example/v1');
  const originalRequest = http.request;
  let routedEndpoint;
  // Validate and construct real remote HTTP endpoints, but route their socket to
  // this offline fixture before any DNS lookup or external connection occurs.
  http.request = function (endpoint, options, callback) {
    routedEndpoint = new URL(endpoint.href);
    const localEndpoint = new URL(endpoint.href);
    localEndpoint.hostname = '127.0.0.1'; localEndpoint.port = String(server.address().port);
    return originalRequest.call(http, localEndpoint, options, callback);
  };
  try {
    for (const [input, normalized] of httpBases) {
      reset('success');
      assert.strictEqual(validateBaseUrl(input), normalized);
      const remoteModel = createModel('http-test', validateBaseUrl(input), {contextWindow: 8192});
      const response = await streamCompatible(remoteModel, originalContext, {apiKey: 'offline-http-fixture', allowTruncation: false}).result();
      assert.strictEqual(response.stopReason, 'stop'); assert.strictEqual(attempts, 1);
      assert.strictEqual(routedEndpoint.href, normalized + '/chat/completions');
      assert.deepStrictEqual(requestPaths, [new URL(normalized + '/chat/completions').pathname]);
    }
  } finally { http.request = originalRequest; }
  async function invoke(options) {
    const stream = streamCompatible(model, originalContext, Object.assign({apiKey: 'client-key-distinct-from-body-secret', allowTruncation: false}, options || {}));
    const events = [];
    for await (const event of stream) events.push(event);
    return {message: await stream.result(), events};
  }
  reset('transient');
  let notices = [];
  let outcome = await fastBackoff(() => invoke({onRetry: notice => notices.push(notice)}));
  assert.strictEqual(attempts, 4);
  assert.strictEqual(outcome.message.stopReason, 'stop');
  assert.strictEqual(outcome.message.content[0].text, 'Success');
  assert.deepStrictEqual(notices.map(notice => notice.delayMs), [2000, 4000, 8000]);
  assert(captures.every(body => body.max_tokens === 512));
  reset('success');
  const summaryResult = await streamCompatible(summaryModel, {systemPrompt: 'Summarize', messages: [{role: 'user', content: 'Earlier work'}], tools: []}, {apiKey: 'key', allowTruncation: false}).result();
  assert.strictEqual(summaryResult.stopReason, 'stop');
  assert.strictEqual(captures[0].max_tokens, 3200);
  assert.deepStrictEqual(notices.map(notice => notice.statusCode), [429, 502, 504]);
  assert.strictEqual(outcome.events.filter(event => event.type === 'text_delta').length, 1);
  reset('exhaust');
  notices = [];
  outcome = await fastBackoff(() => invoke({onRetry: notice => notices.push(notice)}));
  assert.strictEqual(attempts, 4);
  assert.strictEqual(outcome.message.stopReason, 'error');
  assert.strictEqual(notices.length, 3);
  assert(!outcome.message.errorMessage.includes(secret));

  reset('overflow-once');
  const prepareCalls = [];
  outcome = await invoke({autoCompactEnabled: true, prepareRequest: async (context, _signal, force) => {
    prepareCalls.push(force === true);
    assert.strictEqual(context, originalContext, 'Forced compaction must receive the full original context');
    return force ? {...context, messages: [{role: 'user', content: 'compact checkpoint'}, context.messages[2]]} : context;
  }});
  assert.strictEqual(attempts, 2);
  assert.deepStrictEqual(prepareCalls, [false, true]);
  assert.strictEqual(outcome.message.stopReason, 'stop');
  assert(captures[1].messages.some(message => message.content === 'compact checkpoint'));
  assert(!captures[1].messages.some(message => message.content === 'old task'));
  reset('overflow-always');
  let forced = 0;
  outcome = await invoke({autoCompactEnabled: true, prepareRequest: async (context, _signal, force) => { if (force) forced++; return context; }});
  assert.strictEqual(attempts, 2);
  assert.strictEqual(forced, 1);
  assert.strictEqual(outcome.message.stopReason, 'error');
  assert(!outcome.message.errorMessage.includes(secret));
  reset('overflow-always');
  forced = 0;
  outcome = await invoke({autoCompactEnabled: false, prepareRequest: async (context, _signal, force) => { if (force) forced++; return context; }});
  assert.strictEqual(attempts, 1);
  assert.strictEqual(forced, 0);
  reset('overflow-always');
  outcome = await invoke({autoCompactEnabled: true});
  assert.strictEqual(attempts, 1, 'A summary request without prepareRequest must not recursively compact');
  reset('overflow-always');
  outcome = await invoke({autoCompactEnabled: true, prepareRequest: async (context, _signal, force) => { if (force) throw new Error('Summary failed'); return context; }});
  assert.strictEqual(attempts, 1);
  assert.strictEqual(outcome.message.errorMessage, 'Summary failed');

  for (const scenario of ['incomplete', 'malformed', 'partial-text', 'partial-tool', 'auth']) {
    reset(scenario);
    outcome = await fastBackoff(() => invoke());
    assert.strictEqual(attempts, 1, scenario + ' was incorrectly replayed');
    assert.strictEqual(outcome.message.stopReason, 'error');
    assert(!outcome.message.errorMessage.includes(secret));
  }
  reset('cancel');
  const controller = abortController();
  const started = Date.now();
  outcome = await invoke({signal: controller.signal, onRetry: () => setTimeout(() => controller.abort(), 30)});
  assert.strictEqual(attempts, 1);
  assert.strictEqual(outcome.message.stopReason, 'aborted');
  assert(Date.now() - started < 1000, 'Cancellation did not interrupt backoff');
  console.log('PASS provider retry: remote HTTP/LAN URL validation and chat paths (offline), rejected unsafe URL components, bounded 2/4/8-second transient schedule, one forced overflow compaction, disabled/nonrecursive cases, no replay after partial/malformed SSE, secret-safe errors and abortable backoff.');
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).then(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
});
