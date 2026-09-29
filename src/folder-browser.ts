import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface Folder { name: string; path: string; }
export interface FolderListing {
  path: string | null;
  parent: string | null;
  roots: Folder[];
  entries: Folder[];
  truncated: boolean;
}

const MAX_ENTRIES = 1000;

function directoryPath(value: string): string {
  // realpath.native avoids walking protected ancestors of an otherwise readable
  // folder on Windows, and resolves junctions before the UI selects a workspace.
  const resolved = fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
  if (!fs.statSync(resolved).isDirectory()) {
    const error: any = new Error('请选择文件夹');
    error.code = 'ENOTDIR';
    throw error;
  }
  fs.accessSync(resolved, fs.constants.R_OK);
  return resolved;
}

function folderRoots(): Folder[] {
  const roots: Folder[] = [];
  const add = (name: string, value: string) => {
    try {
      const resolved = directoryPath(value);
      if (!roots.some(root => root.path === resolved)) roots.push({ name, path: resolved });
    } catch (_) { /* Disconnected drives and inaccessible home folders are omitted. */ }
  };
  add('用户目录', os.homedir());
  if (process.platform === 'win32') {
    for (let code = 65; code <= 90; code++) {
      const drive = String.fromCharCode(code) + ':\\';
      if (fs.existsSync(drive)) add(drive, drive);
    }
  } else add('文件系统', path.parse(process.cwd()).root);
  return roots;
}

function browsingError(error: any): never {
  const mapped: any = new Error(
    error.code === 'EACCES' || error.code === 'EPERM' ? '没有权限读取此文件夹' :
    error.code === 'ENOENT' ? '文件夹不存在或已断开连接' :
    error.code === 'ENOTDIR' ? '请选择文件夹，不能选择文件' : '无法读取此文件夹'
  );
  mapped.status = error.code === 'EACCES' || error.code === 'EPERM' ? 403 :
    error.code === 'ENOENT' ? 404 : 400;
  throw mapped;
}

/** Read-only, user-facing folder chooser. Agent tools retain their workspace boundary. */
export function listFolders(input?: string): FolderListing {
  if (input !== undefined && (typeof input !== 'string' || input.indexOf('\0') !== -1 ||
    !path.isAbsolute(input) || (process.platform === 'win32' && path.parse(input).root.length === 1))) {
    const error: any = new Error('文件夹必须使用完整的绝对路径');
    error.status = 400;
    throw error;
  }
  const roots = folderRoots();
  const requested = input === undefined ? (roots[0] && roots[0].path) : input;
  if (!requested) return { path: null, parent: null, roots, entries: [], truncated: false };
  try {
    const current = directoryPath(requested);
    const names = fs.readdirSync(current).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const entries: Folder[] = [];
    for (const name of names) {
      try {
        const resolved = directoryPath(path.join(current, name));
        entries.push({ name, path: resolved });
        if (entries.length > MAX_ENTRIES) break;
      } catch (_) { /* Skip files, broken links, removed entries and unreadable directories. */ }
    }
    const parent = path.dirname(current);
    return {
      path: current,
      parent: parent === current ? null : parent,
      roots,
      entries: entries.slice(0, MAX_ENTRIES),
      truncated: entries.length > MAX_ENTRIES,
    };
  } catch (error) { return browsingError(error); }
}
