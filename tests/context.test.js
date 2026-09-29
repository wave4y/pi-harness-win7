'use strict';

const assert = require('assert');
const {DEFAULT_CONTEXT_LIMITS, deriveContextBudget, validateContextLimits, validateRequestLimits, estimateTextTokens, prepareContext} = require(process.env.TEST_CONTEXT_MODULE || '../dist/context.cjs');
const user = text => ({role: 'user', content: text});
const assistant = text => ({role: 'assistant', content: [{type: 'text', text}], stopReason: 'stop'});
const calls = ids => ({role: 'assistant', stopReason: 'toolUse', content: ids.map(id => ({type: 'toolCall', id, name: 'read_file', arguments: {path: id + '.txt'}}))});
const result = (id, text) => ({role: 'toolResult', toolCallId: id, content: [{type: 'text', text}]});
const small = {contextWindow: 2048, maxOutputTokens: 128};

assert.deepStrictEqual(validateContextLimits(), DEFAULT_CONTEXT_LIMITS);
assert.deepStrictEqual(validateContextLimits({maxOutputTokens: 2048}), DEFAULT_CONTEXT_LIMITS);
assert.deepStrictEqual(validateContextLimits({}, small), {contextWindow: 2048, maxOutputTokens: 256});
for (const value of [null, [], 42, '64000']) assert.throws(() => validateContextLimits(value));
for (const value of [0, -1, 2047, 2000001, NaN, Infinity, 65536.2, '64000']) {
  assert.throws(() => validateContextLimits({contextWindow: value}));
}
for (const value of [0, 127, 262145, NaN, Infinity, 4096.2, '4096', null]) {
  assert.deepStrictEqual(validateContextLimits({maxOutputTokens: value}), DEFAULT_CONTEXT_LIMITS, 'Legacy output settings must not control migrated budgets');
}
assert.deepStrictEqual(validateContextLimits({contextWindow: 4096, maxOutputTokens: 3072}), {contextWindow: 4096, maxOutputTokens: 256});
assert.deepStrictEqual(deriveContextBudget(100000), {contextWindow: 100000, maxOutputTokens: 4096, safetyMarginTokens: 2000,
  inputBudget: 93904, reserveTokens: 25088, keepRecentTokens: 31232, summaryMaxOutputTokens: 3200, compactionThreshold: 74912});
let previousOutput = 0;
for (const window of [2048, 2049, 4096, 8192, 16384, 64000, 65536, 100000, 128000, 1000000, 2000000]) {
  const budget = deriveContextBudget(window);
  assert.strictEqual(budget.inputBudget + budget.maxOutputTokens + budget.safetyMarginTokens, window);
  assert(budget.maxOutputTokens >= previousOutput && budget.maxOutputTokens <= 4096);
  assert(budget.summaryMaxOutputTokens <= budget.maxOutputTokens);
  assert(budget.keepRecentTokens + budget.summaryMaxOutputTokens < budget.compactionThreshold);
  assert(budget.compactionThreshold <= budget.inputBudget && budget.inputBudget >= 1024);
  assert(budget.reserveTokens >= budget.maxOutputTokens + budget.safetyMarginTokens);
  previousOutput = budget.maxOutputTokens;
}
assert.deepStrictEqual(validateRequestLimits(small), small, 'Internal summary requests preserve their lower output reserve');
for (const value of [0, 127, 257, '128', Infinity]) assert.throws(() => validateRequestLimits({...small, maxOutputTokens: value}), /内部请求/);
assert.strictEqual(estimateTextTokens(''), 0);
assert.strictEqual(estimateTextTokens('abc'), 1);
assert.strictEqual(estimateTextTokens('中文'), 3);
assert(estimateTextTokens('中文测试') > estimateTextTokens('test'));
assert.strictEqual(estimateTextTokens('😀'), 2);

const history = [user('first'), calls(['one', 'two']), result('one', '中文内容'), result('two', 'second result'), assistant('done'), user('latest')];
const original = JSON.stringify(history);
const full = prepareContext(history, 'system', [], DEFAULT_CONTEXT_LIMITS);
assert.deepStrictEqual(full.messages, history);
assert.notStrictEqual(full.messages, history);
assert.strictEqual(full.stats.droppedTurns, 0);
assert.strictEqual(full.stats.droppedMessages, 0);
assert.strictEqual(full.stats.estimated, true);
assert(full.stats.estimatedTokens > 0);
assert.strictEqual(full.stats.remainingTokens, full.stats.inputBudget - full.stats.estimatedTokens);
assert.strictEqual(full.stats.inputBudget + full.stats.maxOutputTokens + full.stats.safetyMarginTokens, full.stats.contextWindow);
assert.strictEqual(JSON.stringify(history), original);

// An old turn is either retained with every call/result or dropped altogether.
const chain = [user('old'), calls(['first', 'second']), result('first', '中文'.repeat(1100)), result('second', 'more'), assistant('done')];
const recent = [user('new'), calls(['third']), result('third', 'current result')];
const both = chain.concat(recent);
const bothBefore = JSON.stringify(both);
const trimmed = prepareContext(both, 'system', [], small);
assert.deepStrictEqual(trimmed.messages, recent);
assert.strictEqual(trimmed.stats.droppedTurns, 1);
assert.strictEqual(trimmed.stats.droppedMessages, chain.length);
assert.strictEqual(trimmed.stats.totalMessages, both.length);
assert.strictEqual(trimmed.stats.keptMessages, recent.length);
assert.strictEqual(JSON.stringify(both), bothBefore);
assert.throws(() => prepareContext(both, 'system', [], small, {allowTruncation: false}), error => error.code === 'CONTEXT_LIMIT');

const many = [user('oldest' + 'x'.repeat(6000)), assistant('done'), user('middle'), assistant('ok'), user('newest')];
const bounded = prepareContext(many, '', [], small);
assert.deepStrictEqual(bounded.messages, many.slice(2));
assert.strictEqual(bounded.stats.droppedTurns, 1);
assert(bounded.stats.estimatedTokens <= bounded.stats.inputBudget);
const severalOld = [user('x'.repeat(6000)), assistant('done'), user('中'.repeat(2000)), assistant('done'), user('keep')];
assert.strictEqual(prepareContext(severalOld, '', [], small).stats.droppedTurns, 2);
const frozen = Object.freeze([Object.freeze(user('frozen')), Object.freeze(assistant('response'))]);
assert.deepStrictEqual(prepareContext(frozen, '', [], small).messages, frozen);

// Schema names, descriptions, nested JSON and argument text consume the same budget.
const schema = {name: 'search_files', description: '工具描述'.repeat(30), parameters: {type: 'object', properties: {needle: {type: 'string', description: 'query'.repeat(50)}}}};
const schemaContext = prepareContext([user('hi')], 'system', [schema], DEFAULT_CONTEXT_LIMITS);
assert(schemaContext.stats.estimatedTokens > prepareContext([user('hi')], 'system', [], DEFAULT_CONTEXT_LIMITS).stats.estimatedTokens + 100);
assert.throws(() => prepareContext([user('hi')], '系统'.repeat(2000), [], small), error => error.code === 'CONTEXT_LIMIT' && /系统提示/.test(error.message));
assert.throws(() => prepareContext([user('hi')], '', [{name: 'large', description: '中文'.repeat(2000), parameters: {}}], small), error => error.code === 'CONTEXT_LIMIT');
assert.throws(() => prepareContext([user('不能截断'.repeat(1000))], '', [], small), error => error.code === 'CONTEXT_LIMIT' && /未被截断/.test(error.message));
assert.throws(() => prepareContext([user('now'), calls(['huge']), result('huge', '中文'.repeat(2000))], '', [], small), error => error.code === 'CONTEXT_LIMIT');

// A failed response does not reach the provider and does not create phantom tool calls.
const failed = {...calls(['failed']), stopReason: 'aborted'};
assert.deepStrictEqual(prepareContext([user('retry'), failed, user('again')], '', [], small).messages, [user('retry'), user('again')]);
assert.deepStrictEqual(prepareContext([{role: 'custom', content: 'metadata'}, user('hi')], '', [], small).messages, [user('hi')]);
assert.throws(() => prepareContext([user('hi'), calls(['missing'])], '', [], small), /不完整/);
assert.throws(() => prepareContext([user('hi'), result('orphan', 'text')], '', [], small), /没有对应/);
assert.throws(() => prepareContext([user('hi'), calls(['a', 'b']), result('a', 'a'), user('next')], '', [], small), /不完整/);
assert.throws(() => prepareContext([user('hi'), calls(['a', 'a']), result('a', 'a')], '', [], small), /标识无效/);
assert.throws(() => prepareContext([user('hi'), calls(['a']), result('a', 'a'), result('a', 'duplicate')], '', [], small), /没有对应/);
assert.throws(() => prepareContext([user('hi'), calls([''])], '', [], small), /标识无效/);
assert.deepStrictEqual(prepareContext([], '', [], small).messages, []);
assert.throws(() => prepareContext(null, '', [], small), /上下文内容/);
console.log('PASS context budget: validated limits, Chinese/schema estimation, complete tool chains, whole-turn pruning, immutable history and oversized current-turn rejection.');
