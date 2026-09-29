/** Context budgeting at the provider boundary; saved conversation history stays intact. */
export interface ContextLimits {
  contextWindow: number;
  maxOutputTokens: number;
}

export interface ContextBudget extends ContextLimits {
  safetyMarginTokens: number;
  inputBudget: number;
  reserveTokens: number;
  keepRecentTokens: number;
  summaryMaxOutputTokens: number;
  compactionThreshold: number;
}

export interface ContextStats extends ContextLimits {
  estimated: true;
  estimatedTokens: number;
  inputBudget: number;
  safetyMarginTokens: number;
  remainingTokens: number;
  droppedMessages: number;
  droppedTurns: number;
  keptMessages: number;
  totalMessages: number;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = Object.freeze({contextWindow: 64000, maxOutputTokens: 4096});

/** A single model window controls every budget. Values are tokens, not characters. */
export function deriveContextBudget(contextWindow: number): ContextBudget {
  if (!Number.isInteger(contextWindow) || contextWindow < 2048 || contextWindow > 2000000) {
    throw new Error('上下文窗口必须是 2048–2000000 之间的整数');
  }
  const roundUp = (value: number) => Math.ceil(value / 128) * 128;
  const maxOutputTokens = Math.max(256, Math.min(4096, roundUp(contextWindow / 16)));
  const safetyMarginTokens = Math.max(128, Math.min(4096, Math.ceil(contextWindow * 0.02)));
  const inputBudget = contextWindow - maxOutputTokens - safetyMarginTokens;
  const reserveTokens = Math.max(roundUp(contextWindow / 4), maxOutputTokens + safetyMarginTokens);
  const keepRecentTokens = Math.floor(contextWindow * 5 / 16 / 128) * 128;
  const summaryMaxOutputTokens = Math.min(maxOutputTokens, Math.max(512, roundUp(contextWindow / 32)));
  return {contextWindow, maxOutputTokens, safetyMarginTokens, inputBudget, reserveTokens, keepRecentTokens,
    summaryMaxOutputTokens, compactionThreshold: Math.min(inputBudget, contextWindow - reserveTokens)};
}

/** User/persisted configuration: legacy output settings are intentionally ignored. */
export function validateContextLimits(input: any = {}, fallback: ContextLimits = DEFAULT_CONTEXT_LIMITS): ContextLimits {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('上下文设置必须是对象');
  const contextWindow = input.contextWindow === undefined ? fallback.contextWindow : input.contextWindow;
  const {maxOutputTokens} = deriveContextBudget(contextWindow);
  return {contextWindow, maxOutputTokens};
}

/** Internal requests may reserve less output for summaries, never more than the derived cap. */
export function validateRequestLimits(input: ContextLimits): ContextLimits {
  const derived = validateContextLimits(input);
  const maxOutputTokens = input.maxOutputTokens === undefined ? derived.maxOutputTokens : input.maxOutputTokens;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > derived.maxOutputTokens) {
    throw new Error('内部请求输出预算必须是 128–' + derived.maxOutputTokens + ' 之间的整数');
  }
  return {contextWindow: derived.contextWindow, maxOutputTokens};
}

/**
 * No tokenizer can be selected reliably for a user-supplied OpenAI-compatible model.
 * Count ASCII at roughly three characters/token and other UTF-8 text at two bytes/token.
 * This intentionally budgets Chinese and code more cautiously than the common chars/4 rule.
 */
export function estimateTextTokens(value: string): number {
  if (!value) return 0;
  let ascii = 0;
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) < 128) ascii++;
  return Math.ceil(ascii / 3 + (Buffer.byteLength(value, 'utf8') - ascii) / 2);
}

function textContent(content: any): string {
  return typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
    .filter((block: any) => block && block.type === 'text').map((block: any) => block.text || '').join('\n');
}

function toolCalls(message: any): any[] {
  return message.role === 'assistant' && Array.isArray(message.content)
    ? message.content.filter((block: any) => block && block.type === 'toolCall') : [];
}

function messageTokens(message: any): number {
  let result = 10 + estimateTextTokens(textContent(message.content));
  if (message.role === 'toolResult') result += estimateTextTokens(String(message.toolCallId || ''));
  for (const call of toolCalls(message)) {
    result += 16 + estimateTextTokens(String(call.id || '')) + estimateTextTokens(String(call.name || '')) +
      estimateTextTokens(JSON.stringify(call.arguments === undefined ? {} : call.arguments));
  }
  return result;
}

function baseTokens(systemPrompt: string, tools: any[]): number {
  let result = 24 + estimateTextTokens(systemPrompt);
  for (const tool of tools) {
    // Match only the fields sent to the provider; callbacks and UI details are not prompt tokens.
    result += 24 + estimateTextTokens(JSON.stringify({type: 'function', function: {
      name: tool.name, description: tool.description, parameters: tool.parameters,
    }}));
  }
  return result;
}

function ensureCompleteTools(messages: any[]) {
  let pending = new Set<string>();
  for (const message of messages) {
    if (message.role === 'toolResult') {
      if (!pending.delete(message.toolCallId)) throw new Error('会话包含没有对应调用的工具结果，请开启新会话');
      continue;
    }
    if (pending.size) throw new Error('会话包含不完整的工具调用和结果，请开启新会话');
    const calls = toolCalls(message);
    pending = new Set<string>();
    for (const call of calls) {
      if (typeof call.id !== 'string' || !call.id || pending.has(call.id)) throw new Error('会话的工具调用标识无效，请开启新会话');
      pending.add(call.id);
    }
  }
  if (pending.size) throw new Error('会话包含不完整的工具调用和结果，请开启新会话');
}

export function estimateContextTokens(messages: any[], systemPrompt: string, tools: any[]): number {
  if (!Array.isArray(messages) || typeof systemPrompt !== 'string' || !Array.isArray(tools)) throw new Error('上下文内容无效');
  const relevant = messages.filter(message => message && ['user', 'assistant', 'toolResult'].includes(message.role) &&
    !(message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason)));
  ensureCompleteTools(relevant);
  return baseTokens(systemPrompt, tools) + relevant.reduce((sum, message) => sum + messageTokens(message), 0);
}

/**
 * Drop oldest complete user turns until the request fits. The latest user turn,
 * its tool chain, the system prompt and all tool schemas are mandatory.
 * This returns a fresh array without changing messages or their nested content.
 * Throws before network transmission when the mandatory context cannot fit.
 */
export function prepareContext(messages: any[], systemPrompt: string, tools: any[], limits: ContextLimits, policy: {allowTruncation?: boolean} = {}): {messages: any[]; stats: ContextStats} {
  const checked = validateRequestLimits(limits);
  if (!Array.isArray(messages) || typeof systemPrompt !== 'string' || !Array.isArray(tools)) throw new Error('上下文内容无效');
  // The provider omits failed/aborted assistants and non-LLM event messages too.
  const relevant = messages.filter(message => message && ['user', 'assistant', 'toolResult'].includes(message.role) &&
    !(message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason)));
  ensureCompleteTools(relevant);
  const {safetyMarginTokens} = deriveContextBudget(checked.contextWindow);
  const inputBudget = checked.contextWindow - checked.maxOutputTokens - safetyMarginTokens;
  const fixedTokens = baseTokens(systemPrompt, tools);
  const turns: {messages: any[]; tokens: number; userTurn: boolean}[] = [];
  for (const message of relevant) {
    if (message.role === 'user' || !turns.length) turns.push({messages: [], tokens: 0, userTurn: message.role === 'user'});
    const turn = turns[turns.length - 1];
    turn.messages.push(message); turn.tokens += messageTokens(message);
  }
  let estimatedTokens = fixedTokens + turns.reduce((sum, turn) => sum + turn.tokens, 0);
  let firstTurn = 0;
  let droppedMessages = 0;
  let droppedTurns = 0;
  while (policy.allowTruncation !== false && estimatedTokens > inputBudget && firstTurn < turns.length - 1) {
    const removed = turns[firstTurn++];
    estimatedTokens -= removed.tokens;
    droppedMessages += removed.messages.length;
    if (removed.userTurn) droppedTurns++;
  }
  if (estimatedTokens > inputBudget) {
    const detail = fixedTokens > inputBudget ? '系统提示和工具定义' : policy.allowTruncation === false ? '完整会话上下文' : '本轮任务及工具结果';
    const error: any = new Error(detail + '估算需要 ' + estimatedTokens + ' tokens，超过输入预算 ' + inputBudget +
      '。请增大上下文窗口或缩小任务/工具结果；本轮内容未被截断。');
    error.code = 'CONTEXT_LIMIT';
    error.estimatedTokens = estimatedTokens;
    error.inputBudget = inputBudget;
    throw error;
  }
  const prepared: any[] = [];
  for (let index = firstTurn; index < turns.length; index++) prepared.push(...turns[index].messages);
  return {messages: prepared, stats: {
    ...checked, estimated: true, estimatedTokens, inputBudget, safetyMarginTokens,
    remainingTokens: inputBudget - estimatedTokens, droppedMessages, droppedTurns,
    keptMessages: prepared.length, totalMessages: relevant.length,
  }};
}
