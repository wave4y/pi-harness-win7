'use strict';

const assert = require('assert');
const {calculateSessionStats} = require(process.env.TEST_SESSION_STATS_MODULE || '../dist/session-stats.cjs');
const user = text => ({role: 'user', content: text || 'question'});
const assistant = fields => Object.assign({role: 'assistant', content: [], stopReason: 'stop'}, fields);
const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({input, output, cacheRead, cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite, cost: {input: 0, output: 0, total: 0}});
const record = messages => ({sessionId: 'session-id', messages});
const emptyUsage = {input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, reportedSteps: 0, missingSteps: 0, cacheReportedSteps: 0};
const empty = {sessionId: null, turns: 0, steps: 0, modelTimeMs: null, toolTimeMs: null,
  averageFirstTokenMs: null, tokensPerSecond: null, usage: {...emptyUsage, cacheHitRate: null},
  coverage: {timedSteps: 0, toolTimedCalls: 0, toolCalls: 0}, summary: {requests: 0, usage: emptyUsage}};

for (const value of [undefined, null, false, 7, 'record', [], {}, {messages: {role: 'assistant'}, summaryUsage: 'invalid'}]) {
  assert.deepStrictEqual(calculateSessionStats(value), empty);
}

// A new request's explicit zero usage differs from Pi's unreported initial zeros.
const mixed = calculateSessionStats(record([
  user(), assistant(), assistant({usage: usage(0, 0)}),
  assistant({usageReported: true, usage: usage(0, 0), metrics: {requestDurationMs: 0, timeToFirstTokenMs: 0, outputDurationMs: 0}}),
  assistant({usageReported: false, usage: usage(100, 100)}),
  assistant({usage: usage(12, 3)}), assistant({usage: {totalTokens: 7}}),
  assistant({usage: {cost: {total: 25}}}),
]));
assert.strictEqual(mixed.sessionId, 'session-id');
assert.strictEqual(mixed.turns, 1);
assert.strictEqual(mixed.steps, 7);
assert.deepStrictEqual(mixed.usage, {input: 12, output: 3, cacheRead: 0, cacheWrite: 0, total: 22,
  reportedSteps: 3, missingSteps: 4, cacheReportedSteps: 0, cacheHitRate: null});
assert.strictEqual(mixed.modelTimeMs, 0);
assert.strictEqual(mixed.averageFirstTokenMs, 0);
assert.strictEqual(mixed.tokensPerSecond, null, 'Zero output duration is not a usable throughput sample');
assert.deepStrictEqual(mixed.coverage, {timedSteps: 1, toolTimedCalls: 0, toolCalls: 0});

// Cache input is already separate in Pi: never subtract it from input or add it twice.
const cached = calculateSessionStats(record([assistant({usage: usage(100, 20, 300, 100)})]));
assert.deepStrictEqual(cached.usage, {input: 100, cacheRead: 300, cacheWrite: 100, output: 20,
  total: 520, reportedSteps: 1, missingSteps: 0, cacheReportedSteps: 1, cacheHitRate: 0.6});
assert.strictEqual(calculateSessionStats(record([assistant({usage: usage(0, 5)})])).usage.cacheHitRate, null);
const placeholder = calculateSessionStats(record([assistant({usage: {...usage(5, 3, 2, 1), totalTokens: 0}})]));
assert.strictEqual(placeholder.usage.total, 11);
const cacheCoverage = calculateSessionStats(record([
  assistant({usageReported: true, cacheUsageReported: true, usage: usage(100, 20, 300, 100)}),
  assistant({usageReported: true, usage: usage(50000, 10)}),
  assistant({usageReported: true, cacheUsageReported: false, usage: usage(1000, 10, 1000)}),
  assistant({usageReported: false, cacheUsageReported: true, usage: usage(1000, 10, 1000)}),
]));
assert.strictEqual(cacheCoverage.usage.cacheReportedSteps, 1);
assert.strictEqual(cacheCoverage.usage.cacheHitRate, 0.6, 'Only known cache breakdowns contribute to either side of the rate');
assert.strictEqual(calculateSessionStats(record([assistant({usageReported: true, cacheUsageReported: true,
  usage: usage(10, 2)})])).usage.cacheHitRate, 0, 'An explicitly reported zero cache is real zero');
assert.strictEqual(calculateSessionStats(record([assistant({usageReported: true, cacheUsageReported: true,
  usage: usage(0, 0)})])).usage.cacheHitRate, null, 'A zero input denominator has no hit rate');

// Errors, cancellations and tool calls are still measured model steps when saved.
const complete = [user(),
  assistant({stopReason: 'toolUse', usageReported: true, usage: usage(50, 100), metrics: {
    requestCount: 3, requestDurationMs: 3000, timeToFirstTokenMs: 100, outputDurationMs: 1000},
    content: [{type: 'toolCall', id: 'a'}, {type: 'toolCall', id: 'b'}]}),
  {role: 'toolResult', toolCallId: 'a', executionDurationMs: 120},
  {role: 'toolResult', toolCallId: 'b', executionDurationMs: 0},
  assistant({stopReason: 'error', usageReported: true, usage: usage(7, 20), metrics: {
    requestDurationMs: 600, timeToFirstTokenMs: 500, outputDurationMs: 2000}}),
  user(),
  assistant({stopReason: 'aborted', usageReported: true, usage: usage(9, 30), metrics: {
    requestDurationMs: 400, timeToFirstTokenMs: 0, outputDurationMs: 1000}}),
  assistant({usageReported: false, usage: usage(1000, 1000), metrics: {
    requestDurationMs: 200, outputDurationMs: 50000}}),
  {role: 'toolResult', toolCallId: 'old', content: []},
];
const measured = calculateSessionStats(record(complete));
assert.strictEqual(measured.turns, 2);
assert.strictEqual(measured.steps, 4, 'HTTP retries and tool results do not inflate assistant steps');
assert.strictEqual(measured.modelTimeMs, 4200);
assert.strictEqual(measured.toolTimeMs, 120);
assert.strictEqual(measured.averageFirstTokenMs, 200, 'TTFT includes a genuine zero sample');
assert.strictEqual(measured.tokensPerSecond, 37.5, 'Throughput is total eligible output / total eligible duration');
assert.deepStrictEqual(measured.coverage, {timedSteps: 4, toolTimedCalls: 2, toolCalls: 3});
assert.strictEqual(measured.usage.input, 66);
assert.strictEqual(measured.usage.output, 150);
assert.strictEqual(measured.usage.reportedSteps, 3);
assert.strictEqual(measured.usage.missingSteps, 1);

const unknownTimes = calculateSessionStats(record([assistant({usage: usage(10, 3)}),
  {role: 'toolResult', executionDurationMs: null}]));
assert.strictEqual(unknownTimes.modelTimeMs, null);
assert.strictEqual(unknownTimes.toolTimeMs, null);
assert.strictEqual(unknownTimes.averageFirstTokenMs, null);
assert.strictEqual(unknownTimes.tokensPerSecond, null);
assert.deepStrictEqual(unknownTimes.coverage, {timedSteps: 0, toolTimedCalls: 0, toolCalls: 1});
assert.strictEqual(calculateSessionStats(record([{role: 'toolResult', executionDurationMs: 0}])).toolTimeMs, 0);
assert.strictEqual(calculateSessionStats(record([assistant({usageReported: true, usage: usage(0, 0),
  metrics: {outputDurationMs: 1000}})])).tokensPerSecond, 0);

// Summary requests are recorded separately, including missing usage and failed requests.
const withSummary = calculateSessionStats({...record(complete), summaryUsage: [
  assistant({usageReported: true, usage: usage(1000, 80, 20, 5), metrics: {requestDurationMs: 99999, requestCount: 2}}),
  assistant({stopReason: 'error', usage: usage(4, 2)}), assistant({stopReason: 'aborted'}),
  null, user(), {role: 'toolResult', executionDurationMs: 99999},
]});
assert.deepStrictEqual(withSummary.usage, measured.usage);
assert.strictEqual(withSummary.modelTimeMs, measured.modelTimeMs);
assert.strictEqual(withSummary.toolTimeMs, measured.toolTimeMs);
assert.deepStrictEqual(withSummary.summary, {requests: 3, usage: {input: 1004, output: 82, cacheRead: 20,
  cacheWrite: 5, total: 1111, reportedSteps: 2, missingSteps: 1, cacheReportedSteps: 1}});

// Compaction metadata cannot reduce statistics from the complete persisted history.
assert.deepStrictEqual(calculateSessionStats({...record(complete), compaction: {summary: 'tiny', summarizedMessageCount: 7},
  context: {messages: complete.slice(-2)}, contextStats: {keptMessages: 2}}), measured);
const forked = calculateSessionStats({...record(complete.slice(0, 5)), sessionId: 'fork-id'});
assert.strictEqual(forked.sessionId, 'fork-id');
assert.strictEqual(forked.turns, 1);
assert.strictEqual(forked.steps, 2);
assert.strictEqual(forked.usage.total, 177);
assert.strictEqual(forked.usage.missingSteps, 0);
assert.strictEqual(forked.summary.requests, 0, 'Only summary records retained by the branch are counted');

// Invalid fields never become reported values or leak NaN/Infinity into JSON.
const damaged = calculateSessionStats({sessionId: 7, messages: [null, false, 2, [], {},
  assistant({usage: {input: NaN, output: Infinity, cacheRead: -1, cacheWrite: '5', totalTokens: -2},
    metrics: {requestDurationMs: Infinity, timeToFirstTokenMs: -1, outputDurationMs: '1000'}}),
  assistant({usageReported: true, usage: {input: -10, output: 5, cacheRead: 2, cacheWrite: NaN, totalTokens: Infinity},
    metrics: {requestDurationMs: 0, timeToFirstTokenMs: 10, outputDurationMs: 1000}}),
  {role: 'toolResult', executionDurationMs: -1}, {role: 'toolResult', executionDurationMs: '200'},
], summaryUsage: [assistant({usage: null}), {role: 'assistant', usageReported: true, usage: []}]});
assert.strictEqual(damaged.sessionId, null);
assert.deepStrictEqual(damaged.usage, {input: 0, output: 5, cacheRead: 2, cacheWrite: 0, total: 7,
  reportedSteps: 1, missingSteps: 1, cacheReportedSteps: 1, cacheHitRate: 1});
assert.strictEqual(damaged.modelTimeMs, 0);
assert.strictEqual(damaged.averageFirstTokenMs, 10);
assert.strictEqual(damaged.tokensPerSecond, 5);
assert.strictEqual(damaged.toolTimeMs, null);
assert.deepStrictEqual(damaged.summary.usage, {...emptyUsage, reportedSteps: 1, missingSteps: 1});
const extreme = calculateSessionStats(record([1, 2].map(() => assistant({usageReported: true,
  usage: {input: Number.MAX_VALUE, cacheRead: Number.MAX_VALUE, output: Number.MAX_VALUE},
  metrics: {requestDurationMs: Number.MAX_VALUE, outputDurationMs: Number.MIN_VALUE, timeToFirstTokenMs: Number.MAX_VALUE}}))));
assert(Number.isFinite(extreme.usage.total));
assert(Number.isFinite(extreme.modelTimeMs));
assert(Number.isFinite(extreme.tokensPerSecond));
assert.strictEqual(extreme.usage.cacheHitRate, 0.5);

// Frozen histories are supported and the returned objects never alias stored usage.
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.keys(value).forEach(key => freeze(value[key]));
    Object.freeze(value);
  }
  return value;
}
const frozen = freeze({...record(complete), summaryUsage: [assistant({usage: usage(3, 2)})]});
const before = JSON.stringify(frozen);
const first = calculateSessionStats(frozen);
first.usage.input = -999;
first.summary.usage.output = -999;
assert.deepStrictEqual(calculateSessionStats(frozen).usage, measured.usage);
assert.strictEqual(JSON.stringify(frozen), before);

console.log('session-stats: cumulative usage, independent summaries, time coverage and damaged/legacy records passed');
