import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CancellationSignal } from './local-tools';

export type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export const permissionModes = [
  {value: 'read-only', name: '仅可查看', description: '工作区内读取直接执行；修改、区外访问、程序和 MCP 调用逐次确认。'},
  {value: 'workspace-write', name: '工作区内修改', description: '工作区内读写直接执行；区外访问、程序和 MCP 调用逐次确认。'},
  {value: 'danger-full-access', name: '完全权限', description: '本机文件、非 Shell 程序和 MCP 调用直接执行，使用当前 Windows 用户权限。'},
];
export function validPermissionMode(value: any): value is PermissionMode {
  return permissionModes.some(mode => mode.value === value);
}
function inside(root: string, candidate: string): boolean {
  const normalize = (s: string) => process.platform === 'win32' ? s.toLowerCase() : s;
  const relative = path.relative(normalize(root), normalize(candidate));
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function outsideWorkspace(workspace: string, input: any): boolean {
  if (typeof input !== 'string') return true;
  const root = (fs.realpathSync.native || fs.realpathSync)(workspace);
  const target = path.resolve(root, input.replace(/\\/g, path.sep) || '.');
  if (!inside(root, target)) return true;
  // Existing ancestors must also stay in the workspace (including junctions).
  let existing = target;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  try { return !inside(root, (fs.realpathSync.native || fs.realpathSync)(existing)); }
  catch (_) { return true; }
}
export function approvalReason(mode: PermissionMode, workspace: string, tool: any, args: any): string | null {
  if (mode === 'danger-full-access') return null;
  if (tool.mcpServerId) return 'MCP 工具在外部服务或进程中执行，需要确认本次调用。';
  if (tool.name === 'read_skill') return null; // Only enumerated, bounded, user-configured skill roots.
  if (tool.name === 'run_process') return '直接运行的程序不受工作区文件边界限制，需要确认程序和参数。';
  if (outsideWorkspace(workspace, args.path === undefined ? '.' : args.path)) return '此操作访问工作区以外的路径，需要确认。';
  if (['read_file', 'list_directory', 'search_files'].includes(tool.name)) return null;
  if (mode === 'read-only') return '当前为仅可查看模式，需要确认本次文件修改。';
  if (['write_file', 'edit_file', 'create_directory'].includes(tool.name)) return null;
  return '此工具需要确认后执行。';
}

export class ApprovalQueue {
  private pending = new Map<string, any>();
  constructor(private notify: (event: any) => void) {}
  private emit(event: any) { try { this.notify(event); } catch (_) { /* A disconnected UI must not leave an approval Promise pending. */ } }
  list() { return Array.from(this.pending.values()).map(item => item.request); }
  request(toolCallId: string, toolName: string, args: any, reason: string, signal?: CancellationSignal): Promise<void> {
    if (signal && signal.aborted) return Promise.reject(new Error('已取消'));
    const id = crypto.randomBytes(16).toString('hex');
    const request = {id, toolCallId, toolName, args, reason};
    return new Promise((resolve, reject) => {
      const finish = (decision: string) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        if (signal) signal.removeEventListener('abort', abort);
        this.emit({type: 'approval_resolved', id, decision});
        if (decision === 'allow') resolve();
        else reject(new Error(decision === 'deny' ? '用户拒绝了此工具调用。请解释结果并等待新指示，不要换一种方式重试被拒绝的操作。' : '工具审批已取消。'));
      };
      const abort = () => finish('cancel');
      this.pending.set(id, {request, finish});
      if (signal) signal.addEventListener('abort', abort, {once: true});
      if (signal && signal.aborted) { abort(); return; }
      this.emit({type: 'approval_request', ...request});
    });
  }
  decide(id: string, decision: any) {
    if (!['allow', 'deny'].includes(decision)) throw new Error('审批决定无效');
    const pending = this.pending.get(id);
    if (!pending) { const e: any = new Error('审批已结束或不存在'); e.status = 409; throw e; }
    pending.finish(decision);
  }
  cancel() { for (const pending of Array.from(this.pending.values())) pending.finish('cancel'); }
}
