'use strict';
const assert = require('assert');
const {autoCompact, deriveCompactionSettings, validateCompactionSettings, DEFAULT_COMPACTION_SETTINGS, SUMMARIZATION_SYSTEM_PROMPT} = require(process.env.TEST_COMPACTION_MODULE || '../dist/compaction.cjs');
const {prepareContext} = require(process.env.TEST_CONTEXT_MODULE || '../dist/context.cjs');
const user = content => ({role: 'user', content, timestamp: 1});
const assistant = content => ({role: 'assistant', content: [{type: 'text', text: content}], stopReason: 'stop', timestamp: 2});
const call = (id, name, args) => ({role: 'assistant', content: [{type: 'toolCall', id, name: name || 'read_file', arguments: args || {path: id + '.txt'}}], stopReason: 'toolUse', timestamp: 3});
const result = (id, content) => ({role: 'toolResult', toolCallId: id, content: [{type: 'text', text: content}], timestamp: 4});
const limits = {contextWindow: 8192, maxOutputTokens: 512};
const smallKeep = {enabled: true, reserveTokens: 16384, keepRecentTokens: 128};
const context = messages => ({messages, systemPrompt: 'Use the supplied tools.', tools: []});
function summarizer(calls, modelLimits) {
  return async (prompt, options) => {
    calls.push({prompt, options});
    assert.strictEqual(options.systemPrompt, SUMMARIZATION_SYSTEM_PROMPT);
    assert(options.maxOutputTokens <= modelLimits.maxOutputTokens);
    prepareContext([user(prompt)], options.systemPrompt, [], {...modelLimits, maxOutputTokens: options.maxOutputTokens}, {allowTruncation: false});
    assert.strictEqual(Buffer.from(prompt, 'utf8').toString('utf8'), prompt, 'Summary fragment split a Unicode surrogate pair');
    return '## Goal\nContinue the user task.\n\n## Progress\nEarlier work preserved.\n\n## Next Steps\nFinish the requested work.';
  };
}

async function main() {
  assert.deepStrictEqual(validateCompactionSettings(), {enabled: true, reserveTokens: 16000, keepRecentTokens: 19968});
  assert.deepStrictEqual(deriveCompactionSettings(100000), {enabled: true, reserveTokens: 25088, keepRecentTokens: 31232});
  assert.deepStrictEqual(deriveCompactionSettings(8192, {}, {enabled: false}), {enabled: false, reserveTokens: 2048, keepRecentTokens: 2560});
  assert.deepStrictEqual(validateCompactionSettings({enabled: false}), {...DEFAULT_COMPACTION_SETTINGS, enabled: false});
  for (const value of [null, [], 123, 'settings']) assert.throws(() => validateCompactionSettings(value));
  for (const value of ['true', 1, null]) assert.throws(() => validateCompactionSettings({enabled: value}));
  for (const key of ['reserveTokens', 'keepRecentTokens']) for (const value of [0, -1, 127, 2000001, Infinity, 128.5, '20000']) {
    assert.deepStrictEqual(validateCompactionSettings({[key]: value}), DEFAULT_COMPACTION_SETTINGS, 'Ignore obsolete numeric settings during migration');
  }
  let requests = [];
  const brief = context([user('Hi'), assistant('Hello'), user('Continue')]);
  const untouched = await autoCompact(brief, limits, DEFAULT_COMPACTION_SETTINGS, null, {summarize: summarizer(requests, limits)});
  assert.strictEqual(untouched.compacted, false);
  assert.strictEqual(untouched.state, null);
  assert.deepStrictEqual(untouched.context.messages, brief.messages);
  assert.strictEqual(requests.length, 0);
  assert.strictEqual(untouched.stats.effectiveReserveTokens, 2048);

  // Large history is sent to the summarizer in bounded chunks, never all at once.
  const large = context([user('Old goal ' + '中文😀'.repeat(7000)), assistant('Old response'), user('CURRENT_REQUEST_VERBATIM')]);
  const original = JSON.stringify(large);
  requests = [];
  const compacted = await autoCompact(large, limits, DEFAULT_COMPACTION_SETTINGS, null, {summarize: summarizer(requests, limits)});
  assert.strictEqual(compacted.compacted, true);
  assert(requests.length > 1, 'Oversized source must be chunked');
  assert(compacted.context.messages.some(message => message.content === 'CURRENT_REQUEST_VERBATIM'));
  assert(compacted.context.messages.some(message => String(message.content).includes('<summary>')));
  assert.strictEqual(JSON.stringify(large), original);
  assert(compacted.stats.estimatedTokens <= compacted.stats.inputBudget);
  assert.strictEqual(compacted.stats.droppedMessages, 0, 'Compaction must not silently trim the prepared context');
  assert(requests[0].prompt.includes('## Goal'));
  assert(requests.slice(1).every(request => request.prompt.includes('<previous-summary>')));
  assert(compacted.state.prefixHash.length === 64);

  // A checkpoint survives JSON persistence, and sending again does not re-summarize.
  const restoredState = JSON.parse(JSON.stringify(compacted.state));
  requests = [];
  const restored = await autoCompact(large, limits, DEFAULT_COMPACTION_SETTINGS, restoredState, {summarize: summarizer(requests, limits)});
  assert.strictEqual(restored.compacted, false);
  assert.strictEqual(requests.length, 0);
  assert.deepStrictEqual(restored.context.messages, compacted.context.messages);
  const altered = context(large.messages.map((message, index) => index === 0 ? user('History was replaced') : message));
  const statuses = [];
  const reset = await autoCompact(altered, limits, {...DEFAULT_COMPACTION_SETTINGS, enabled: false}, restoredState, {summarize: summarizer([], limits), onStatus: event => statuses.push(event)});
  assert.strictEqual(reset.state, null);
  assert(reset.context.messages.some(message => message.content === 'History was replaced'));
  assert(statuses.some(event => event.phase === 'reset'));

  // Split a single enormous user turn only at completed assistant/tool-result groups.
  const oneTurn = context([
    user('NEVER_LOSE_THE_LATEST_REQUEST'),
    call('early', 'read_file', {path: 'source.txt'}), result('early', '中'.repeat(5000)),
    call('written', 'write_file', {path: 'output.txt', content: 'changed'}), result('written', '中'.repeat(2500)),
    call('recent'), result('recent', 'recent tool output'),
  ]);
  const oneBefore = JSON.stringify(oneTurn);
  requests = [];
  const split = await autoCompact(oneTurn, limits, smallKeep, null, {summarize: summarizer(requests, limits)});
  assert(split.compacted);
  assert.strictEqual(split.state.summarizedMessageCount, 5);
  assert.deepStrictEqual(split.context.messages.slice(-2), oneTurn.messages.slice(-2));
  assert(split.context.messages.some(message => message.content === 'NEVER_LOSE_THE_LATEST_REQUEST'));
  assert.deepStrictEqual(split.state.readFiles, ['source.txt']);
  assert.deepStrictEqual(split.state.modifiedFiles, ['output.txt']);
  assert(split.state.summary.includes('<modified-files>\noutput.txt'));
  assert.strictEqual(JSON.stringify(oneTurn), oneBefore);
  prepareContext(split.context.messages, oneTurn.systemPrompt, [], limits, {allowTruncation: false});

  // A checkpoint that covers all history can itself be compacted after shrinking the window.
  const largeWindow = {contextWindow: 64000, maxOutputTokens: 4096};
  const entirelySummarized = context([user('Keep this current request'), assistant('Old work '.repeat(10000))]);
  const largeCheckpoint = await autoCompact(entirelySummarized, largeWindow, smallKeep, null, {force: true, summarize: async () => 'previous summary '.repeat(500)});
  assert.strictEqual(largeCheckpoint.state.summarizedMessageCount, entirelySummarized.messages.length);
  const reducedLimits = {contextWindow: 2048, maxOutputTokens: 128};
  requests = [];
  const reduced = await autoCompact(entirelySummarized, reducedLimits, smallKeep, largeCheckpoint.state, {summarize: summarizer(requests, reducedLimits)});
  assert(reduced.compacted);
  assert(requests.length > 1);
  assert(reduced.stats.estimatedTokens <= reduced.stats.inputBudget);
  assert(reduced.context.messages.some(message => message.content === 'Keep this current request'));

  // Incremental compaction uses the previous summary and carries file tracking forward.
  const later = context(oneTurn.messages.concat([assistant('previous turn completed'), user('NEXT_TASK'), call('later', 'read_file', {path: 'later.txt'}), result('later', 'text') ]));
  requests = [];
  const stateBefore = JSON.stringify(split.state);
  const incremental = await autoCompact(later, limits, smallKeep, split.state, {force: true, summarize: summarizer(requests, limits)});
  assert(incremental.compacted);
  assert(requests[0].prompt.includes('<previous-summary>'));
  assert(requests[0].prompt.includes(split.state.summary));
  assert(incremental.state.summarizedMessageCount > split.state.summarizedMessageCount);
  assert(incremental.state.modifiedFiles.includes('output.txt'));
  assert.strictEqual(JSON.stringify(split.state), stateBefore);

  // Disabled auto-compaction is a hard error at capacity, not silent old-turn loss.
  let invoked = false;
  await assert.rejects(autoCompact(large, limits, {...DEFAULT_COMPACTION_SETTINGS, enabled: false}, null, {summarize: async () => { invoked = true; return 'unexpected'; }}), error => error.code === 'CONTEXT_LIMIT');
  assert.strictEqual(invoked, false);
  requests = [];
  const manual = await autoCompact(brief, limits, {...DEFAULT_COMPACTION_SETTINGS, enabled: false}, null, {force: true, summarize: summarizer(requests, limits)});
  assert.strictEqual(manual.compacted, true);
  assert.strictEqual(requests.length, 1);
  const lone = await autoCompact(context([user('Only a new request')]), limits, smallKeep, null, {force: true, summarize: async () => { throw new Error('Must not summarize the current request alone'); }});
  assert.strictEqual(lone.compacted, false);
  await assert.rejects(autoCompact(context([user('本轮'.repeat(10000))]), limits, smallKeep, null, {summarize: async () => { throw new Error('Must not summarize oversized current request'); }}), error => error.code === 'CONTEXT_LIMIT');

  // Failure, cancellation, empty summaries and overlarge summaries commit no state.
  const failureHistory = JSON.stringify(later);
  const fail = () => autoCompact(later, limits, smallKeep, split.state, {force: true, summarize: async () => { throw new Error('Mock summary provider failed'); }});
  await assert.rejects(fail(), /Mock summary provider failed/);
  await assert.rejects(autoCompact(later, limits, smallKeep, split.state, {force: true, summarize: async () => ''}), /空摘要/);
  await assert.rejects(autoCompact(later, limits, smallKeep, split.state, {force: true, summarize: async () => '巨大摘要'.repeat(15000)}), /预算/);
  const signal = {aborted: false};
  await assert.rejects(autoCompact(later, limits, smallKeep, split.state, {force: true, signal, summarize: async (_prompt, options) => {
    assert.strictEqual(options.signal, signal); signal.aborted = true; return 'cancelled summary';
  }}), error => error.code === 'ABORT_ERR');
  assert.strictEqual(JSON.stringify(split.state), stateBefore);
  assert.strictEqual(JSON.stringify(later), failureHistory);
  await assert.rejects(autoCompact(context([user('Bad chain'), call('orphan')]), limits, smallKeep, null, {force: true, summarize: async () => 'never'}), /不完整/);
  console.log('PASS compaction: automatic window budgets, legacy settings migration, upstream Pi prompts, bounded incremental summaries, preserved current request and tool pairs, persisted anchors, immutable history, failure/cancel rollback, auto-off overflow and manual force.');
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
