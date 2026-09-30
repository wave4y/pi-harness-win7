/** Cumulative measured statistics from the persisted, uncompacted session history. */
export interface SessionUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
  reportedSteps: number;
  missingSteps: number;
  cacheReportedSteps: number;
}

export interface SessionStats {
  sessionId: string | null;
  turns: number;
  steps: number;
  modelTimeMs: number | null;
  toolTimeMs: number | null;
  averageFirstTokenMs: number | null;
  tokensPerSecond: number | null;
  usage: SessionUsage & {cacheHitRate: number | null};
  coverage: {timedSteps: number; toolTimedCalls: number; toolCalls: number};
  summary: {requests: number; usage: SessionUsage};
}

function object(value: any): any {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function measured(value: any): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function count(value: any): number {
  return measured(value) ? value : 0;
}

// Corrupted records must never make JSON statistics contain Infinity/NaN.
function add(left: number, right: number): number {
  return Math.min(Number.MAX_VALUE, left + right);
}

function emptyUsage(): SessionUsage {
  return {input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, reportedSteps: 0, missingSteps: 0, cacheReportedSteps: 0};
}

function hasReportedUsage(message: any): boolean {
  if (typeof message.usageReported === 'boolean') return message.usageReported;
  const usage = object(message.usage);
  // Pi's initial zero-filled usage/cost is not evidence of provider reporting.
  return ['input', 'cacheRead', 'cacheWrite', 'output', 'totalTokens']
    .some(key => measured(usage[key]) && usage[key] > 0);
}

function hasReportedCacheUsage(message: any): boolean {
  if (typeof message.cacheUsageReported === 'boolean') return message.cacheUsageReported;
  const usage = object(message.usage);
  return ['cacheRead', 'cacheWrite'].some(key => measured(usage[key]) && usage[key] > 0);
}

function accumulateUsage(target: SessionUsage, message: any): boolean {
  if (!hasReportedUsage(message)) {
    target.missingSteps++;
    return false;
  }
  const usage = object(message.usage);
  const input = count(usage.input);
  const cacheRead = count(usage.cacheRead);
  const cacheWrite = count(usage.cacheWrite);
  const output = count(usage.output);
  // Pi input excludes cache reads/writes. A positive reported total is authoritative;
  // old zero placeholders fall back to the sum of the separately reported fields.
  const total = measured(usage.totalTokens) && usage.totalTokens > 0
    ? usage.totalTokens : add(add(input, cacheRead), add(cacheWrite, output));
  target.input = add(target.input, input);
  target.cacheRead = add(target.cacheRead, cacheRead);
  target.cacheWrite = add(target.cacheWrite, cacheWrite);
  target.output = add(target.output, output);
  target.total = add(target.total, total);
  target.reportedSteps++;
  if (hasReportedCacheUsage(message)) target.cacheReportedSteps++;
  return true;
}

export function calculateSessionStats(record: any): SessionStats {
  const source = object(record);
  const messages = Array.isArray(source.messages) ? source.messages : [];
  const usage = emptyUsage();
  const summaryUsage = emptyUsage();
  let turns = 0;
  let steps = 0;
  let modelTime = 0;
  let toolTime = 0;
  let timedSteps = 0;
  let toolTimedCalls = 0;
  let toolCalls = 0;
  let firstTokenCount = 0;
  let averageFirstToken = 0;
  let outputTokens = 0;
  let outputTime = 0;
  let cacheInput = 0;
  let cacheReadInput = 0;
  let cacheWriteInput = 0;

  for (const value of messages) {
    const message = object(value);
    if (message.role === 'user') {
      turns++;
    } else if (message.role === 'toolResult') {
      toolCalls++;
      if (measured(message.executionDurationMs)) {
        toolTimedCalls++;
        toolTime = add(toolTime, message.executionDurationMs);
      }
    } else if (message.role === 'assistant') {
      steps++;
      const reported = accumulateUsage(usage, message);
      if (reported && hasReportedCacheUsage(message)) {
        const reportedUsage = object(message.usage);
        cacheInput = add(cacheInput, count(reportedUsage.input));
        cacheReadInput = add(cacheReadInput, count(reportedUsage.cacheRead));
        cacheWriteInput = add(cacheWriteInput, count(reportedUsage.cacheWrite));
      }
      const metrics = object(message.metrics);
      if (measured(metrics.requestDurationMs)) {
        timedSteps++;
        modelTime = add(modelTime, metrics.requestDurationMs);
      }
      if (measured(metrics.timeToFirstTokenMs)) {
        firstTokenCount++;
        averageFirstToken += (metrics.timeToFirstTokenMs - averageFirstToken) / firstTokenCount;
      }
      if (reported && measured(metrics.outputDurationMs) && metrics.outputDurationMs > 0) {
        outputTokens = add(outputTokens, count(object(message.usage).output));
        outputTime = add(outputTime, metrics.outputDurationMs);
      }
    }
  }

  let summaryRequests = 0;
  for (const value of Array.isArray(source.summaryUsage) ? source.summaryUsage : []) {
    const message = object(value);
    if (message.role !== 'assistant') continue;
    summaryRequests++;
    accumulateUsage(summaryUsage, message);
  }

  // Scaling the denominator avoids overflow for damaged but finite stored numbers.
  const inputScale = Math.max(cacheInput, cacheReadInput, cacheWriteInput);
  const cacheDenominator = cacheInput + cacheReadInput + cacheWriteInput;
  const cacheHitRate = inputScale === 0 ? null : Number.isFinite(cacheDenominator)
    ? cacheReadInput / cacheDenominator : (cacheReadInput / inputScale) /
      (cacheInput / inputScale + cacheReadInput / inputScale + cacheWriteInput / inputScale);
  return {
    sessionId: typeof source.sessionId === 'string' ? source.sessionId : null,
    turns,
    steps,
    modelTimeMs: timedSteps ? modelTime : null,
    toolTimeMs: toolTimedCalls ? toolTime : null,
    averageFirstTokenMs: firstTokenCount ? averageFirstToken : null,
    tokensPerSecond: outputTime > 0 ? Math.min(Number.MAX_VALUE, outputTokens / outputTime * 1000) : null,
    usage: {...usage, cacheHitRate},
    coverage: {timedSteps, toolTimedCalls, toolCalls},
    summary: {requests: summaryRequests, usage: summaryUsage},
  };
}
