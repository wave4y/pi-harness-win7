'use strict';
const assert = require('assert');
const http = require('http');
const {createModel, streamCompatible, validateBaseUrl} = require('../dist/provider.cjs');
const secret = 'provider-error-body-secret-never-echo';
let mode = '';
let attempts = 0;
let captures = [];
let requestPaths = [];
let usageFrames = [];
const sockets = new Set();
function frame(delta, finish) { return 'data: ' + JSON.stringify({choices: [{index: 0, delta: delta || {}, finish_reason: finish || null}]}) + '\n\n'; }
function usageFrame(usage) { return 'data: ' + JSON.stringify({choices: [], usage}) + '\n\n'; }
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', value => chunks.push(value));
  req.on('end', () => {
    attempts++;
    captures.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    requestPaths.push(req.url);
    if ((['unsupported-usage', 'unsupported-text', 'unsupported-message'].includes(mode) && captures[captures.length - 1].stream_options)
      || mode === 'unsupported-always' || mode === 'unsupported-ambiguous' || mode === 'unsupported-auth'
      || (mode === 'unsupported-then-transient' && attempts === 1)) {
      res.writeHead(mode === 'unsupported-auth' ? 401 : 400, {'Content-Type': 'application/json'});
      if (mode === 'unsupported-text') { res.end('Unrecognized request argument supplied: stream_options ' + secret); return; }
      if (mode === 'unsupported-message') { res.end(JSON.stringify({error: {type: 'invalid_request_error', message: 'stream_options.include_usage is not supported. ' + secret}})); return; }
      res.end(JSON.stringify({error: mode === 'unsupported-ambiguous'
        ? {code: 'invalid_value', param: 'stream_options', message: 'Unknown model; stream_options was accepted. ' + secret}
        : {code: 'unsupported_parameter', param: 'stream_options', message: 'Unsupported parameter: stream_options ' + secret}}));
      return;
    }
    let status = 0;
    if (mode === 'transient' && attempts <= 3) status = [429, 502, 504][attempts - 1];
    if (mode === 'exhaust' || mode === 'cancel') status = 503;
    if (mode === 'overflow-always' || mode === 'overflow-once' && attempts === 1) status = 400;
    if (mode === 'auth') status = 401;
    if (mode === 'unsupported-then-transient' && attempts <= 4) status = [429, 502, 504][attempts - 2];
    if (status) {
      res.writeHead(status, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: {code: status === 400 ? 'context_length_exceeded' : 'temporary_failure', message: 'Maximum context length exceeded ' + secret}}));
      return;
    }
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    if (mode === 'usage' || mode === 'usage-empty') {
      res.end(frame({role: 'assistant', content: ''}) + (mode === 'usage' ? frame({content: 'Success'}) : '') + frame({}, 'stop') + usageFrames.map(usageFrame).join('') + 'data: [DONE]\n\n');
      return;
    }
    if (mode === 'usage-final-choice') {
      res.end(frame({content: 'Success'}) + 'data: ' + JSON.stringify({choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: usageFrames[0]}) + '\n\ndata: [DONE]\n\n');
      return;
    }
    if (mode.startsWith('metrics-')) {
      const scenario = mode;
      req.socket.setNoDelay(true);
      res.write(frame({role: 'assistant', content: ''}));
      setTimeout(() => {
        res.write(frame(scenario === 'metrics-reasoning' ? {reasoning_content: 'Reasoning'}
          : scenario === 'metrics-tool' ? {tool_calls: [{index: 0}]} : {content: 'First'}));
        setTimeout(() => {
          res.write(frame(scenario === 'metrics-tool' ? {tool_calls: [{index: 0, id: 'metric-call', function: {name: 'read_file', arguments: '{"path":"fixture.txt"}'}}]} : {content: 'Last'}));
          setTimeout(() => res.end(frame({}, scenario === 'metrics-tool' ? 'tool_calls' : 'stop') + usageFrame({prompt_tokens: 30, completion_tokens: 10, total_tokens: 40}) + 'data: [DONE]\n\n'), 30);
        }, 30);
      }, 30);
      return;
    }
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
function reset(value) { mode = value; attempts = 0; captures = []; requestPaths = []; usageFrames = []; }
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
  const usageCases = [
    {name: 'OpenAI cache', value: {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: {cached_tokens: 60}}, expected: [40, 20, 60, 120], cache: true},
    {name: 'DeepSeek cache', value: {prompt_tokens: 80, completion_tokens: 10, total_tokens: 90, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 50}, expected: [50, 10, 30, 90], cache: true},
    {name: 'both cache aliases', value: {prompt_tokens: 80, completion_tokens: 10, total_tokens: 90, prompt_tokens_details: {cached_tokens: 30}, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 50}, expected: [50, 10, 30, 90], cache: true},
    {name: 'DeepSeek split input', value: {completion_tokens: 10, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 50}, expected: [50, 10, 30, 90], cache: true},
    {name: 'DeepSeek reported miss', value: {prompt_tokens: 80, completion_tokens: 10, prompt_cache_miss_tokens: 50}, expected: [50, 10, 30, 90], cache: true},
    {name: 'no cache breakdown', value: {prompt_tokens: 30, completion_tokens: 5}, expected: [30, 5, 0, 35], cache: false},
    {name: 'reported zero', value: {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: {cached_tokens: 0}}, expected: [0, 0, 0, 0], cache: true},
  ];
  for (const sample of usageCases) {
    reset('usage'); usageFrames = [null, sample.value];
    const result = (await invoke()).message;
    assert.strictEqual(result.usageReported, true, sample.name);
    assert.strictEqual(result.cacheUsageReported, sample.cache, sample.name);
    assert.deepStrictEqual([result.usage.input, result.usage.output, result.usage.cacheRead, result.usage.totalTokens], sample.expected, sample.name);
    assert.deepStrictEqual(captures[0].stream_options, {include_usage: true});
    assert.strictEqual(result.metrics.requestCount, 1);
  }
  for (const value of [null, {}, {prompt_tokens: 100}, {prompt_tokens: '100', completion_tokens: 1}, {prompt_tokens: -1, completion_tokens: 1}, {prompt_tokens: 1.5, completion_tokens: 1}, {prompt_tokens: 3, completion_tokens: 1, total_tokens: 0}, {prompt_tokens: 3, completion_tokens: 1, prompt_tokens_details: {cached_tokens: 4}}]) {
    reset('usage'); usageFrames = [value];
    const result = (await invoke()).message;
    assert.strictEqual(result.stopReason, 'stop'); assert.strictEqual(result.usageReported, false);
    assert.strictEqual(result.cacheUsageReported, false); assert.strictEqual(result.usage.totalTokens, 0);
  }
  reset('usage-final-choice'); usageFrames = [usageCases[1].value];
  assert.strictEqual((await invoke()).message.usage.totalTokens, 90, 'Usage attached to a final DeepSeek choice must be read');
  reset('usage'); usageFrames = [usageCases[0].value, usageCases[0].value, {}];
  assert.strictEqual((await invoke()).message.usage.totalTokens, 120, 'Cumulative/repeated usage is replaced, never summed per chunk');
  reset('usage-empty'); usageFrames = [usageCases[6].value];
  const empty = (await invoke()).message;
  assert.strictEqual(empty.usageReported, true); assert.strictEqual(empty.metrics.timeToFirstTokenMs, null); assert.strictEqual(empty.metrics.outputDurationMs, null);
  reset('success');
  const absentUsage = (await invoke()).message;
  assert.strictEqual(absentUsage.usageReported, false); assert.strictEqual(absentUsage.cacheUsageReported, false);

  for (const scenario of ['metrics-text', 'metrics-reasoning', 'metrics-tool']) {
    reset(scenario);
    const result = (await invoke()).message;
    assert.strictEqual(result.stopReason, scenario === 'metrics-tool' ? 'toolUse' : 'stop');
    assert.strictEqual(result.metrics.requestCount, 1);
    assert(result.metrics.timeToFirstTokenMs >= (scenario === 'metrics-tool' ? 40 : 10), 'Empty role/tool placeholders must not start latency timing');
    assert(result.metrics.outputDurationMs >= (scenario === 'metrics-tool' ? 15 : 40), 'Reasoning and nonempty tool deltas must start output timing');
    assert.strictEqual(result.metrics.requestDurationMs, result.metrics.timeToFirstTokenMs + result.metrics.outputDurationMs);
  }
  reset('metrics-text');
  let summaryMessage, prepareElapsed;
  const timingStarted = Date.now();
  const preparedResult = (await invoke({prepareRequest: async context => {
    const started = Date.now();
    summaryMessage = await streamCompatible(summaryModel, {systemPrompt: 'Summary', tools: [], messages: [{role: 'user', content: 'Earlier work'}]}, {apiKey: 'offline-summary'}).result();
    prepareElapsed = Date.now() - started;
    return context;
  }})).message;
  assert.strictEqual(attempts, 2); assert.strictEqual(preparedResult.metrics.requestCount, 1); assert.strictEqual(summaryMessage.metrics.requestCount, 1);
  assert(Date.now() - timingStarted - preparedResult.metrics.requestDurationMs >= prepareElapsed - 2, 'Main request duration must exclude nested preparation/summary requests');
  reset('success');
  const preparationFailure = (await invoke({prepareRequest: async () => { throw new Error('fixture preparation failure'); }})).message;
  assert.strictEqual(attempts, 0); assert.deepStrictEqual(preparationFailure.metrics, {requestDurationMs: 0, requestCount: 0, timeToFirstTokenMs: null, outputDurationMs: null});
  let compatibilityNotices = [];
  for (const scenario of ['unsupported-usage', 'unsupported-text', 'unsupported-message']) {
    reset(scenario); compatibilityNotices = [];
    const compatible = (await invoke({onRetry: event => compatibilityNotices.push(event)})).message;
    assert.strictEqual(compatible.stopReason, 'stop'); assert.strictEqual(compatible.metrics.requestCount, 2); assert.strictEqual(compatible.usageReported, false);
    assert.deepStrictEqual(captures.map(body => body.stream_options), [{include_usage: true}, undefined]);
    assert.deepStrictEqual(compatibilityNotices.map(event => event.reason), ['stream_options_unsupported']);
  }
  for (const scenario of ['unsupported-always', 'unsupported-ambiguous', 'unsupported-auth']) {
    reset(scenario);
    const result = (await invoke()).message;
    assert.strictEqual(attempts, scenario === 'unsupported-always' ? 2 : 1);
    assert.strictEqual(result.stopReason, 'error'); assert(!result.errorMessage.includes(secret));
  }
  reset('unsupported-then-transient'); compatibilityNotices = [];
  const mixedRetries = (await fastBackoff(() => invoke({onRetry: event => compatibilityNotices.push(event)}))).message;
  assert.strictEqual(mixedRetries.stopReason, 'stop'); assert.strictEqual(mixedRetries.metrics.requestCount, 5);
  assert.deepStrictEqual(compatibilityNotices.map(event => event.delayMs), [0, 2000, 4000, 8000]);
  assert(captures.slice(1).every(body => body.stream_options === undefined));
  reset('transient');
  const originalTimeout = global.setTimeout;
  let backoffElapsed = 0, delayedResult;
  global.setTimeout = (callback, ms, ...args) => {
    if (![2000, 4000, 8000].includes(ms)) return originalTimeout(callback, ms, ...args);
    const started = Date.now();
    return originalTimeout(() => { backoffElapsed += Date.now() - started; callback(...args); }, 30);
  };
  const delayedStarted = Date.now();
  try { delayedResult = (await invoke()).message; } finally { global.setTimeout = originalTimeout; }
  assert.strictEqual(delayedResult.stopReason, 'stop'); assert.strictEqual(delayedResult.metrics.requestCount, 4);
  assert(backoffElapsed >= 60);
  assert(Date.now() - delayedStarted - delayedResult.metrics.requestDurationMs >= backoffElapsed - 2, 'Request duration must exclude retry backoff');
  reset('transient');
  let notices = [];
  let outcome = await fastBackoff(() => invoke({onRetry: notice => notices.push(notice)}));
  assert.strictEqual(attempts, 4);
  assert.strictEqual(outcome.message.metrics.requestCount, 4);
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
  console.log('PASS provider: reported OpenAI/DeepSeek usage and cache accounting, zero/absent/invalid distinctions, request metrics excluding summaries/backoff, first content/reasoning/tool latency, bounded unsupported-stream-options fallback, HTTP/LAN paths, bounded retries, overflow compaction, no partial replay, secret-safe errors and cancellation.');
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).then(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
});
