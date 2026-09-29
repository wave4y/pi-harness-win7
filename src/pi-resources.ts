/**
 * Pi coding-agent v0.51.6 project context and prompt-template port.
 * Portions Copyright (c) 2025 Mario Zechner, MIT licensed.
 * See src/vendor/pi-resources/PROVENANCE.txt and LICENSE.txt.
 */
import * as fs from 'fs';
import * as path from 'path';

const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_TEMPLATES = 256;
const realpath = fs.realpathSync.native || fs.realpathSync;

export interface PiResourceSettings {
  enabled: boolean;
  includeAncestors: boolean;
  /** Explicit global Pi agent directory. Empty means do not scan the user's home. */
  agentDir: string;
  /** Explicit prompt Markdown files or directories. */
  promptPaths: string[];
}
export interface PromptTemplate {
  name: string;
  description: string;
  content: string;
  source: string;
  filePath: string;
}
export interface PiResources {
  cwd: string;
  contextFiles: Array<{ path: string; content: string }>;
  systemPrompt?: string;
  systemPromptPath?: string;
  appendSystemPrompt?: string;
  appendSystemPromptPath?: string;
  prompts: PromptTemplate[];
  warnings: string[];
}

function absoluteLocal(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value) || /^[\\/]{2}/.test(value) || /[\x00-\x1f<>"|?*]/.test(value)) throw new Error('Pi resource paths must be absolute local paths.');
  if (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(value)) throw new Error('Pi resource paths must include their drive letter.');
  const driveRemoved = process.platform === 'win32' ? value.replace(/^[a-z]:/i, '') : value;
  if (driveRemoved.includes(':')) throw new Error('Pi resource paths cannot use alternate data streams.');
  for (const segment of driveRemoved.split(/[\\/]/)) {
    if (!segment || segment === '.' || segment === '..') continue;
    if (/[. ]$/.test(segment) || /^(con|conin\$|conout\$|clock\$|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(segment)) throw new Error('Reserved or ambiguous Pi resource path.');
  }
  return path.resolve(value);
}

export function validatePiResourceSettings(input: any = {}, previous?: PiResourceSettings): PiResourceSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Pi resource settings must be an object.');
  const base = previous || { enabled: true, includeAncestors: true, agentDir: '', promptPaths: [] };
  const result = { ...base, promptPaths: base.promptPaths.slice() };
  for (const key of ['enabled', 'includeAncestors'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') throw new Error('Pi resource ' + key + ' must be boolean.');
      result[key] = input[key];
    }
  }
  if (input.agentDir !== undefined) result.agentDir = input.agentDir === '' ? '' : absoluteLocal(input.agentDir);
  if (input.promptPaths !== undefined) {
    if (!Array.isArray(input.promptPaths) || input.promptPaths.length > 16) throw new Error('Pi promptPaths must contain at most 16 absolute paths.');
    result.promptPaths = input.promptPaths.map(absoluteLocal);
  }
  return result;
}

function normalize(value: string): string { return process.platform === 'win32' ? value.toLowerCase() : value; }
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(normalize(root), normalize(candidate));
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

/** Quoted command argument parser adapted directly from Pi prompt-templates.ts. */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i];
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") inQuote = char;
    else if (char === ' ' || char === '\t') {
      if (current) { args.push(current); current = ''; }
    } else current += char;
  }
  if (current) args.push(current);
  return args;
}

/** Pi positional/wildcard syntax. One pass preserves literal placeholders in arguments. */
export function substituteArgs(content: string, args: string[]): string {
  let bytes = Buffer.byteLength(content);
  const output = content.replace(/\$\{@:(\d+)(?::(\d+))?\}|\$(\d+)|\$ARGUMENTS|\$@/g, (matched, sliceStart, sliceLength, position) => {
    let replacement: string;
    if (position !== undefined) replacement = args[parseInt(position, 10) - 1] || '';
    else if (sliceStart !== undefined) {
      const start = Math.max(0, parseInt(sliceStart, 10) - 1);
      replacement = args.slice(start, sliceLength === undefined ? undefined : start + parseInt(sliceLength, 10)).join(' ');
    } else replacement = args.join(' ');
    bytes += Buffer.byteLength(replacement) - Buffer.byteLength(matched);
    if (bytes > 256 * 1024) throw new Error('Expanded Pi prompt exceeds 256 KiB.');
    return replacement;
  });
  if (Buffer.byteLength(output) > 256 * 1024) throw new Error('Expanded Pi prompt exceeds 256 KiB.');
  return output;
}

export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
  if (!text.startsWith('/')) return text;
  const command = /^\/([^\s]+)(?:[ \t]([\s\S]*))?$/.exec(text);
  if (!command) return text;
  const template = templates.find(item => item.name === command[1]);
  return template ? substituteArgs(template.content, parseCommandArgs(command[2] || '')) : text;
}

function unquoteDescription(value: string): string {
  const input = value.trim();
  if (input.startsWith('"')) {
    try { const parsed = JSON.parse(input); if (typeof parsed === 'string') return parsed; } catch (_) { /* invalid scalar */ }
    throw new Error('Unsupported quoted prompt description.');
  }
  if (input.startsWith("'")) {
    if (!input.endsWith("'")) throw new Error('Unclosed prompt description.');
    return input.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[\[\]{&*!]/.test(input)) throw new Error('Prompt description must be a scalar string; YAML collections, tags and aliases are not supported.');
  return input.replace(/\s+#.*$/, '');
}

// Pi templates only use description metadata. Support ordinary quoted/unquoted
// strings and folded/literal blocks without introducing a YAML runtime package.
function parseTemplate(raw: string): { description: string; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.startsWith('---\n')) return { description: '', body: normalized };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { description: '', body: normalized };
  const header = normalized.slice(4, end).split('\n');
  let description = '';
  let found = false;
  for (let index = 0; index < header.length; index++) {
    const match = /^description:\s*(.*)$/.exec(header[index]);
    if (!match) continue;
    if (found) throw new Error('Duplicate prompt description.');
    found = true;
    if (/^[>|][+-]?$/.test(match[1])) {
      const block: string[] = [];
      while (index + 1 < header.length && (/^\s+/.test(header[index + 1]) || header[index + 1] === '')) block.push(header[++index].trim());
      description = block.join(match[1].startsWith('|') ? '\n' : ' ').trim();
    } else description = unquoteDescription(match[1]);
    if (description.length > 2048) throw new Error('Prompt description exceeds 2048 characters.');
  }
  return { description, body: normalized.slice(end + 4).trim() };
}

export function loadPiResources(workspace: string, rawSettings: Partial<PiResourceSettings> = {}): PiResources {
  const settings = validatePiResourceSettings(rawSettings);
  const cwd = realpath(workspace);
  if (!fs.statSync(cwd).isDirectory()) throw new Error('Pi workspace is not a directory.');
  const result: PiResources = { cwd, contextFiles: [], prompts: [], warnings: [] };
  if (!settings.enabled) return result;
  let totalBytes = 0;
  const read = (file: string, boundary: string): { path: string; content: string } | undefined => {
    try {
      const actual = realpath(file);
      if (!inside(boundary, actual)) throw new Error('Resource symbolic link points outside its configured directory.');
      const stat = fs.statSync(actual);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Resource must be a regular UTF-8 file under 128 KiB.');
      if (totalBytes + stat.size > MAX_TOTAL_BYTES) throw new Error('Pi resources exceed the 1 MiB total limit.');
      const bytes = fs.readFileSync(actual);
      if (bytes.length > MAX_FILE_BYTES || totalBytes + bytes.length > MAX_TOTAL_BYTES) throw new Error('Pi resource size limit exceeded.');
      const content = bytes.toString('utf8');
      if (bytes.includes(0) || !Buffer.from(content, 'utf8').equals(bytes)) throw new Error('Resource is binary or is not valid UTF-8.');
      totalBytes += bytes.length;
      return { path: actual, content: content.replace(/^\uFEFF/, '') };
    } catch (error) {
      if ((error as any).code !== 'ENOENT') result.warnings.push(file + ': ' + (error as Error).message);
      return undefined;
    }
  };
  const configuredRoot = (directory: string, boundary?: string): string | undefined => {
    try {
      const actual = realpath(directory);
      if (!fs.statSync(actual).isDirectory()) throw new Error('Not a directory.');
      if (boundary && !inside(boundary, actual)) throw new Error('Resource directory links outside the workspace.');
      return actual;
    } catch (error) {
      if ((error as any).code !== 'ENOENT') result.warnings.push(directory + ': ' + (error as Error).message);
      return undefined;
    }
  };
  const seenContexts = new Set<string>();
  const contextFrom = (directory: string) => {
    for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
      const loaded = read(path.join(directory, filename), directory);
      if (loaded) {
        if (!seenContexts.has(normalize(loaded.path))) { seenContexts.add(normalize(loaded.path)); result.contextFiles.push(loaded); }
        break; // AGENTS.md wins over CLAUDE.md at each directory, as in Pi.
      }
    }
  };
  const agentDir = settings.agentDir ? configuredRoot(settings.agentDir) : undefined;
  if (settings.agentDir && !agentDir && !fs.existsSync(settings.agentDir)) result.warnings.push('Global Pi agent directory does not exist: ' + settings.agentDir);
  if (agentDir) contextFrom(agentDir);
  const ancestors = [cwd];
  if (settings.includeAncestors) {
    let current = cwd;
    while (path.dirname(current) !== current && ancestors.length < 128) { current = path.dirname(current); ancestors.unshift(current); }
  }
  for (const directory of ancestors) contextFrom(directory);
  const projectPi = configuredRoot(path.join(cwd, '.pi'), cwd);
  const systemFile = (filename: string) => {
    // An existing project file shadows the global file, even if invalid. Report
    // its error instead of silently loading a different global instruction.
    const directory = projectPi && fs.existsSync(path.join(projectPi, filename)) ? projectPi : agentDir;
    return directory ? read(path.join(directory, filename), directory) : undefined;
  };
  const system = systemFile('SYSTEM.md');
  if (system) { result.systemPrompt = system.content; result.systemPromptPath = system.path; }
  const append = systemFile('APPEND_SYSTEM.md');
  if (append) { result.appendSystemPrompt = append.content; result.appendSystemPromptPath = append.path; }

  const seenTemplates = new Set<string>(), templateNames = new Set<string>();
  const templateFile = (file: string, boundary: string, source: string, label: string) => {
    if (result.prompts.length >= MAX_TEMPLATES) { result.warnings.push('Pi template count exceeds 256.'); return; }
    const loaded = read(file, boundary);
    if (!loaded || seenTemplates.has(normalize(loaded.path))) return;
    seenTemplates.add(normalize(loaded.path));
    try {
      const name = path.basename(file).replace(/\.md$/, '');
      if (!/^[^\s\\/\x00-\x1f]{1,80}$/.test(name)) throw new Error('Template name cannot contain whitespace or path separators and must be at most 80 characters.');
      const parsed = parseTemplate(loaded.content);
      let description = parsed.description;
      if (!description) {
        const firstLine = parsed.body.split('\n').find(line => line.trim());
        if (firstLine) description = firstLine.slice(0, 60) + (firstLine.length > 60 ? '...' : '');
      }
      if (templateNames.has(name)) { result.warnings.push('Prompt /' + name + ' collision: kept the first source, skipped ' + loaded.path); return; }
      templateNames.add(name);
      result.prompts.push({ name, description: description ? description + ' ' + label : label, content: parsed.body, source, filePath: loaded.path });
    } catch (error) { result.warnings.push(file + ': ' + (error as Error).message); }
  };
  const templateDirectory = (directory: string, boundary: string, source: string, label: string) => {
    const actual = configuredRoot(directory, boundary);
    if (!actual) return;
    try {
      // Match Pi's non-recursive prompt-directory discovery.
      const entries = fs.readdirSync(actual, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries.slice(0, 2048)) {
        if (result.prompts.length >= MAX_TEMPLATES) { result.warnings.push('Pi template count exceeds 256.'); break; }
        if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md')) templateFile(path.join(actual, entry.name), boundary, source, label);
      }
      if (entries.length > 2048) result.warnings.push('Pi prompt directory scan stopped after 2048 entries: ' + directory);
    } catch (error) { result.warnings.push(directory + ': ' + (error as Error).message); }
  };
  if (agentDir) templateDirectory(path.join(agentDir, 'prompts'), agentDir, 'user', '(user)');
  if (projectPi) templateDirectory(path.join(projectPi, 'prompts'), cwd, 'project', '(project)');
  for (const configured of settings.promptPaths) {
    try {
      const actual = realpath(configured);
      const stat = fs.statSync(actual);
      const label = '(path:' + (path.basename(configured).replace(/\.md$/, '') || 'path') + ')';
      if (stat.isDirectory()) templateDirectory(actual, actual, 'path', label);
      else if (stat.isFile() && configured.endsWith('.md')) templateFile(actual, path.dirname(actual), 'path', label);
      else result.warnings.push('Explicit Pi prompt path must be a Markdown file or directory: ' + configured);
    } catch (error) { result.warnings.push(configured + ': ' + (error as Error).message); }
  }
  result.warnings = result.warnings.slice(0, 100);
  return result;
}

/** Pi's custom/default + append + project-context prompt layout. */
export function buildPiResourcePrompt(defaultPrompt: string, resources: PiResources): string {
  let prompt = resources.systemPrompt || defaultPrompt;
  if (resources.appendSystemPrompt) prompt += '\n\n' + resources.appendSystemPrompt;
  if (resources.contextFiles.length > 0) {
    prompt += '\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n';
    for (const context of resources.contextFiles) prompt += '## ' + context.path + '\n\n' + context.content + '\n\n';
  }
  return prompt;
}
