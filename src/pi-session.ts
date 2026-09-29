import { SessionManager } from './vendor/pi-coding-agent/session-manager';
import * as crypto from 'crypto';
export { buildSessionContext as buildPiSessionContext } from './vendor/pi-coding-agent/session-manager';

function makeSession(record: any) {
  const manager = SessionManager.inMemory(record.workspace);
  if (record.name) manager.appendSessionInfo(record.name);
  manager.appendModelChange('custom', record.model || 'custom');
  manager.appendCustomEntry('pi-win7-web', {sessionId: record.sessionId, permissionMode: record.permissionMode});
  const ids = (record.messages || []).map((message: any) => manager.appendMessage(message));
  return {manager, ids};
}
export function exportPiJsonl(record: any): string {
  const {manager, ids} = makeSession(record);
  const compact = record.compactionState;
  const history = record.messages || [];
  const count = compact && compact.summarizedMessageCount;
  if (compact && typeof compact.summary === 'string' && compact.summary.trim() && Number.isInteger(count) && count > 0 && count <= history.length) {
    const hash = crypto.createHash('sha256');
    for (let index = 0; index < count; index++) hash.update(JSON.stringify(history[index]) + '\n');
    // Never export a checkpoint against a different history than the one summarized.
    if (compact.prefixHash === hash.digest('hex')) {
      const retained = history.slice(count).filter((message: any) => ['user', 'assistant', 'toolResult'].includes(message.role) &&
        !(message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason)));
      const firstKept = retained[0];
      if (!firstKept || firstKept.role !== 'toolResult') {
        let latestUser = -1;
        for (let index = history.length - 1; index >= 0; index--) if (history[index].role === 'user') { latestUser = index; break; }
        if (latestUser >= 0 && latestUser < count) retained.unshift(history[latestUser]);
        // Keep every original entry, including the old suffix, as a navigable
        // branch. The active branch repeats only the context actually retained
        // by the adapter, including its verbatim current request for split turns.
        manager.branch(ids[count - 1]);
        const retainedIds = retained.map((message: any) => manager.appendMessage(message));
        const boundary = retainedIds[0] || manager.appendCustomEntry('pi-win7-web-compaction-boundary', {});
        manager.appendCompaction(compact.summary, boundary, compact.tokensBefore || 0, {
          adapter: 'pi-win7-web',
          readFiles: Array.isArray(compact.readFiles) ? compact.readFiles : [],
          modifiedFiles: Array.isArray(compact.modifiedFiles) ? compact.modifiedFiles : [],
        });
      }
    }
  }
  return [manager.getHeader(), ...manager.getEntries()].map(item => JSON.stringify(item)).join('\n') + '\n';
}
function hasPendingToolCalls(message: any): boolean {
  return message.role === 'assistant' && !['aborted', 'error'].includes(message.stopReason) &&
    Array.isArray(message.content) && message.content.some((block: any) => block.type === 'toolCall');
}
export function forkPiMessages(record: any, index?: number): any[] {
  const history = record.messages || [];
  if (!history.length) return [];
  const point = index === undefined ? history.length - 1 : index;
  if (!Number.isInteger(point) || point < 0 || point >= history.length) throw new Error('会话分支位置无效');
  const message = history[point];
  if (hasPendingToolCalls(message)) throw new Error('不能从等待工具结果的消息处分支');
  if (message.role === 'toolResult') {
    let start = point - 1;
    while (start >= 0 && history[start].role === 'toolResult') start--;
    const calls = start >= 0 ? (history[start].content || []).filter((block: any) => block.type === 'toolCall') : [];
    const results = new Set(history.slice(start + 1, point + 1).map((item: any) => item.toolCallId));
    if (!calls.length || calls.some((call: any) => !results.has(call.id))) throw new Error('不能拆开工具调用及结果');
  }
  const {manager, ids} = makeSession(record);
  manager.branch(ids[point]);
  return manager.buildSessionContext().messages;
}
export function piSessionTree(record: any) {
  const {manager, ids} = makeSession(record);
  const byId = new Map(ids.map((id: string, index: number) => [id, index]));
  return manager.getEntries().filter((item: any) => item.type === 'message').map((item: any) => ({
    id: item.id, parentId: item.parentId, index: byId.get(item.id), role: item.message.role,
    preview: typeof item.message.content === 'string' ? item.message.content.slice(0, 160) : (item.message.content || []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n').slice(0, 160),
    canFork: !hasPendingToolCalls(item.message) && item.message.role !== 'toolResult',
  }));
}
function escape(value: any): string { return String(value === undefined ? '' : value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'} as any)[character]); }
export function exportSessionHtml(record: any): string {
  const entries = (record.messages || []).map((message: any) => {
    const content = typeof message.content === 'string' ? message.content : (message.content || []).map((block: any) => block.type === 'text' ? block.text : block.type === 'toolCall' ? block.name + '\n' + JSON.stringify(block.arguments, null, 2) : '').filter(Boolean).join('\n');
    return '<article><h2>' + escape(message.role) + '</h2><pre>' + escape(content) + '</pre></article>';
  }).join('\n');
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>' + escape(record.name || 'Pi 会话') + '</title><style>body{font:15px/1.65 "Segoe UI","Microsoft YaHei",sans-serif;margin:40px auto;max-width:900px;padding:0 24px;color:#222}h1{font-size:25px}h2{font-size:13px;color:#666}article{padding:14px 0;border-top:1px solid #ddd}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>' + escape(record.name || 'Pi 会话') + '</h1><p>' + escape(record.workspace) + ' · ' + escape(record.model) + '</p>' + entries + '</html>';
}
