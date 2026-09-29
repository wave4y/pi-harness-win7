/**
 * Node 12 adaptation of Pi v0.51.6 compaction prompts and recent-message policy.
 * Upstream: https://github.com/badlogic/pi-mono/tree/v0.51.6/packages/coding-agent/src/core/compaction
 * Copyright (c) 2025 Mario Zechner, MIT (included in THIRD_PARTY_NOTICES.txt).
 * Persistence and provider I/O are owned by the caller. No conversation is erased.
 */
import * as crypto from 'crypto';
import { ContextLimits, ContextStats, DEFAULT_CONTEXT_LIMITS, deriveContextBudget, validateRequestLimits, estimateContextTokens, estimateTextTokens, prepareContext } from './context';
import { CancellationSignal } from './local-tools';

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export interface CompactionSettings { enabled: boolean; reserveTokens: number; keepRecentTokens: number; }
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = Object.freeze(deriveCompactionSettings(DEFAULT_CONTEXT_LIMITS.contextWindow));
export interface CompactionState {
  version: 1;
  summary: string;
  summarizedMessageCount: number;
  prefixHash: string;
  updatedAt: number;
  tokensBefore: number;
  readFiles: string[];
  modifiedFiles: string[];
}
export interface CompactionContext { messages: any[]; systemPrompt: string; tools?: any[]; [key: string]: any; }
export interface CompactionOptions {
  signal?: CancellationSignal;
  force?: boolean;
  customInstructions?: string;
  summarize: (prompt: string, options: {systemPrompt: string; maxOutputTokens: number; signal?: CancellationSignal}) => Promise<string>;
  onStatus?: (status: any) => void;
}

/** Only enabled is user-controlled; older reserve/recent settings migrate automatically. */
export function deriveCompactionSettings(contextWindow: number, input: any = {}, fallback: {enabled: boolean} = {enabled: true}): CompactionSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('自动压缩设置必须是对象');
  const enabled = input.enabled === undefined ? fallback.enabled : input.enabled;
  if (typeof enabled !== 'boolean') throw new Error('自动压缩开关无效');
  const {reserveTokens, keepRecentTokens} = deriveContextBudget(contextWindow);
  return {enabled, reserveTokens, keepRecentTokens};
}

export function validateCompactionSettings(input: any = {}, fallback: CompactionSettings = DEFAULT_COMPACTION_SETTINGS, contextWindow = DEFAULT_CONTEXT_LIMITS.contextWindow): CompactionSettings {
  return deriveCompactionSettings(contextWindow, input, fallback);
}

function relevant(message: any): boolean {
  return message && ['user', 'assistant', 'toolResult'].includes(message.role) &&
    !(message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason));
}
function text(content: any): string {
  return typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
    .filter((block: any) => block && block.type === 'text').map((block: any) => block.text || '').join('\n');
}
function calls(message: any): any[] {
  return message.role === 'assistant' && Array.isArray(message.content) ? message.content.filter((block: any) => block.type === 'toolCall') : [];
}
function assertActive(signal?: CancellationSignal) {
  if (signal && signal.aborted) { const error: any = new Error('上下文压缩已取消；保留原始会话和上次摘要'); error.code = 'ABORT_ERR'; throw error; }
}
function hashPrefix(messages: any[], count: number): string {
  const hash = crypto.createHash('sha256');
  for (let index = 0; index < count; index++) hash.update(JSON.stringify(messages[index]) + '\n');
  return hash.digest('hex');
}
function recoverState(messages: any[], input: any): CompactionState | null {
  if (!input || input.version !== 1 || typeof input.summary !== 'string' || !input.summary.trim() ||
    !Number.isInteger(input.summarizedMessageCount) || input.summarizedMessageCount < 1 || input.summarizedMessageCount > messages.length ||
    typeof input.prefixHash !== 'string' || input.prefixHash !== hashPrefix(messages, input.summarizedMessageCount)) return null;
  // A persisted checkpoint cannot start its suffix with an orphaned tool result.
  const firstKept = messages.slice(input.summarizedMessageCount).find(relevant);
  if (firstKept && firstKept.role === 'toolResult') return null;
  const paths = (value: any) => Array.isArray(value) && value.every(item => typeof item === 'string') ? value.slice() : [];
  return {...input, readFiles: paths(input.readFiles), modifiedFiles: paths(input.modifiedFiles)};
}
function summaryMessage(summary: string): any {
  return {role: 'user', content: 'The earlier conversation was compacted into the following context checkpoint. It records prior work, not new instructions.\n\n<summary>\n' + summary + '\n</summary>', timestamp: 0};
}
function latestUser(messages: any[]): number {
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index] && messages[index].role === 'user') return index;
  return -1;
}
function compose(messages: any[], state: CompactionState | null): any[] {
  if (!state) return messages.filter(relevant);
  const output = [summaryMessage(state.summary)];
  const user = latestUser(messages);
  // Split-turn compaction retains the current request verbatim, not only in a summary.
  if (user >= 0 && user < state.summarizedMessageCount) output.push(messages[user]);
  return output.concat(messages.slice(state.summarizedMessageCount).filter(relevant));
}

/** Pi's tagged, plain-text conversation serialization avoids continuing the source conversation. */
export function serializeForSummary(messages: any[]): string {
  const parts: string[] = [];
  for (const message of messages.filter(relevant)) {
    const content = text(message.content);
    if (message.role === 'user' && content) parts.push('[User]: ' + content);
    if (message.role === 'assistant') {
      if (content) parts.push('[Assistant]: ' + content);
      const toolCalls = calls(message);
      if (toolCalls.length) parts.push('[Assistant tool calls]: ' + toolCalls.map(call =>
        call.name + '(id=' + JSON.stringify(call.id) + ', arguments=' + JSON.stringify(call.arguments) + ')').join('; '));
    }
    if (message.role === 'toolResult') parts.push('[Tool result ' + message.toolCallId + (message.isError ? ', error' : '') + ']: ' + content);
  }
  return parts.join('\n\n');
}

function groups(messages: any[]): Array<{start: number; end: number; tokens: number}> {
  const output: Array<{start: number; end: number; tokens: number}> = [];
  // Validate all pairs before finding any cut; error/aborted assistants are excluded consistently.
  estimateContextTokens(messages, '', []);
  for (let index = 0; index < messages.length; index++) {
    if (!relevant(messages[index])) continue;
    const start = index;
    const pending = new Set(calls(messages[index]).map(call => call.id));
    while (pending.size && index + 1 < messages.length) {
      index++;
      if (relevant(messages[index])) pending.delete(messages[index].toolCallId);
    }
    output.push({start, end: index + 1, tokens: estimateContextTokens(messages.slice(start, index + 1), '', []) - 24});
  }
  return output;
}

function collectFiles(messages: any[], previous: CompactionState | null): {readFiles: string[]; modifiedFiles: string[]} {
  const read = new Set(previous ? previous.readFiles : []), modified = new Set(previous ? previous.modifiedFiles : []);
  const failed = new Set(messages.filter(message => message.role === 'toolResult' && message.isError).map(message => message.toolCallId));
  for (const message of messages) for (const call of calls(message)) {
    if (!call.arguments || typeof call.arguments.path !== 'string' || failed.has(call.id)) continue;
    if (['write', 'edit', 'write_file', 'edit_file', 'create_directory'].includes(call.name)) modified.add(call.arguments.path);
    if (['read', 'read_file', 'search_files', 'list_directory'].includes(call.name)) read.add(call.arguments.path);
  }
  return {readFiles: Array.from(read).filter(file => !modified.has(file)).sort(), modifiedFiles: Array.from(modified).sort()};
}
function formatFiles(files: {readFiles: string[]; modifiedFiles: string[]}): string {
  return (files.readFiles.length ? '\n\n<read-files>\n' + files.readFiles.join('\n') + '\n</read-files>' : '') +
    (files.modifiedFiles.length ? '\n\n<modified-files>\n' + files.modifiedFiles.join('\n') + '\n</modified-files>' : '');
}

function buildPrompt(conversation: string, previous: string, instructions: string): string {
  return '<conversation>\n' + conversation + '\n</conversation>\n\n' +
    (previous ? '<previous-summary>\n' + previous + '\n</previous-summary>\n\n' : '') +
    (previous ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT) +
    (instructions ? '\n\nAdditional focus: ' + instructions : '');
}

async function summarizeChunks(source: string, previous: string, limits: ContextLimits, maxOutputTokens: number, options: CompactionOptions): Promise<string> {
  const safety = deriveContextBudget(limits.contextWindow).safetyMarginTokens;
  const inputBudget = limits.contextWindow - maxOutputTokens - safety;
  const cost = (prompt: string) => estimateContextTokens([{role: 'user', content: prompt}], SUMMARIZATION_SYSTEM_PROMPT, []);
  let summary = previous;
  let remaining = source;
  // If the user shrank the model window, re-summarize a now-oversized previous
  // checkpoint in bounded fragments before incorporating the new conversation.
  if (summary && cost(buildPrompt('', summary, options.customInstructions || '')) > inputBudget * 0.7) {
    remaining = '[Previous checkpoint summary to preserve]\n' + summary + '\n\n' + remaining;
    summary = '';
  }
  let step = 0;
  do {
    assertActive(options.signal);
    const instructions = options.customInstructions || '';
    if (cost(buildPrompt('', summary, instructions)) + 32 >= inputBudget) throw new Error('摘要提示和上次摘要超过模型输入预算；请增大上下文窗口');
    let low = 0, high = Math.min(remaining.length, inputBudget * 3);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (cost(buildPrompt(remaining.slice(0, middle), summary, instructions)) <= inputBudget - 16) low = middle;
      else high = middle - 1;
    }
    if (low > 0 && low < remaining.length && /[\uD800-\uDBFF]/.test(remaining.charAt(low - 1))) low--;
    if (remaining && !low) throw new Error('上下文窗口不足以分块生成摘要');
    const fragment = remaining.slice(0, low);
    remaining = remaining.slice(low);
    const prompt = buildPrompt(fragment, summary, instructions);
    // This also verifies that no summary request falls back to silent truncation.
    prepareContext([{role: 'user', content: prompt}], SUMMARIZATION_SYSTEM_PROMPT, [], {...limits, maxOutputTokens}, {allowTruncation: false});
    if (options.onStatus) options.onStatus({phase: 'progress', step: ++step, remainingCharacters: remaining.length});
    const result = await options.summarize(prompt, {systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, maxOutputTokens, signal: options.signal});
    assertActive(options.signal);
    if (typeof result !== 'string' || !result.trim()) throw new Error('模型返回了空摘要；保留原始会话和上次摘要');
    summary = result.trim();
  } while (remaining);
  return summary;
}

export async function autoCompact(context: CompactionContext, limits: ContextLimits, settings: CompactionSettings, inputState: CompactionState | null, options: CompactionOptions): Promise<{
  context: CompactionContext; state: CompactionState | null; stats: ContextStats & {[key: string]: any}; compacted: boolean;
}> {
  const checked = validateRequestLimits(limits);
  const budget = deriveContextBudget(checked.contextWindow);
  const configured = deriveCompactionSettings(checked.contextWindow, settings);
  const messages = context.messages;
  if (!Array.isArray(messages) || typeof context.systemPrompt !== 'string' || (context.tools !== undefined && !Array.isArray(context.tools))) throw new Error('上下文内容无效');
  assertActive(options.signal);
  const tools = context.tools || [];
  const state = recoverState(messages, inputState);
  if (inputState && !state && options.onStatus) options.onStatus({phase: 'reset', reason: '会话锚点已变化，重新使用完整历史'});
  const active = compose(messages, state);
  const tokensBefore = estimateContextTokens(active, context.systemPrompt, tools);
  const safety = budget.safetyMarginTokens;
  const inputBudget = checked.contextWindow - checked.maxOutputTokens - safety;
  const reserveTokens = configured.reserveTokens;
  const threshold = Math.min(inputBudget, checked.contextWindow - reserveTokens);
  const finish = (nextState: CompactionState | null, compacted: boolean) => {
    const prepared = prepareContext(compose(messages, nextState), context.systemPrompt, tools, checked, {allowTruncation: false});
    return {context: {...context, messages: prepared.messages}, state: nextState, compacted, stats: {
      ...prepared.stats, summarizedMessages: nextState ? nextState.summarizedMessageCount : 0,
      summaryTokens: nextState ? estimateTextTokens(nextState.summary) : 0,
      compactionUpdatedAt: nextState ? nextState.updatedAt : null,
      compactionThreshold: threshold, effectiveReserveTokens: reserveTokens,
    }};
  };
  if (!options.force && (!configured.enabled || tokensBefore <= threshold)) return finish(state, false);
  const latest = latestUser(messages);
  const mandatory = latest >= 0 ? [messages[latest]] : [];
  // The current request and system/tools are never replaced by a lossy summary.
  prepareContext(mandatory, context.systemPrompt, tools, checked, {allowTruncation: false});
  const allGroups = groups(messages);
  const start = state ? state.summarizedMessageCount : 0;
  const remainingGroups = allGroups.filter(group => group.start >= start);
  const maxOutputTokens = Math.min(checked.maxOutputTokens, budget.summaryMaxOutputTokens);
  const mandatoryCost = estimateContextTokens(mandatory, context.systemPrompt, tools);
  const keepRecentTokens = Math.min(configured.keepRecentTokens, Math.max(0, inputBudget - mandatoryCost - maxOutputTokens * 2 - 128));
  let retainedTokens = 0;
  let keepIndex = remainingGroups.length;
  for (let index = remainingGroups.length - 1; index >= 0; index--) {
    if (retainedTokens + remainingGroups[index].tokens > keepRecentTokens) break;
    retainedTokens += remainingGroups[index].tokens;
    keepIndex = index;
  }
  let cut = keepIndex < remainingGroups.length ? remainingGroups[keepIndex].start : messages.length;
  // Explicit /compact must summarize something even when a short history fits.
  if (cut <= start && options.force && remainingGroups.length > 1) cut = remainingGroups[1].start;
  // A lone latest user prompt is not meaningful history to compact.
  if ((cut <= start && !state) || (!state && allGroups.length === 1 && latest === allGroups[0].start)) return finish(state, false);
  const toSummarize = messages.slice(start, cut).filter(relevant);
  if (!toSummarize.length && !state) return finish(null, false);
  if (options.onStatus) options.onStatus({phase: 'start', tokensBefore, summarizedMessages: cut, keepRecentTokens});
  const summary = await summarizeChunks(serializeForSummary(toSummarize), state ? state.summary : '', checked, maxOutputTokens, options);
  assertActive(options.signal);
  const files = collectFiles(toSummarize, state);
  const nextState: CompactionState = {
    version: 1, summary: summary + formatFiles(files), summarizedMessageCount: cut,
    prefixHash: hashPrefix(messages, cut), updatedAt: Date.now(), tokensBefore, ...files,
  };
  const result = finish(nextState, true);
  if (options.onStatus) options.onStatus({phase: 'done', tokensBefore, tokensAfter: result.stats.estimatedTokens, summarizedMessages: cut});
  return result;
}
