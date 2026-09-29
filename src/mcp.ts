import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { spawn, ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { CancellationSignal } from './local-tools';
import { truncateHead } from './vendor/pi-coding-agent/truncate';

// Dependency-free MCP client for Node 12: stdio and Streamable HTTP POST
// (application/json and SSE responses). No legacy HTTP+SSE, OAuth, sampling,
// elicitation, background GET stream or automatic reconnect/replayed tool calls.
const PROTOCOL = '2025-03-26';
const MAX_MESSAGE = 2 * 1024 * 1024;
const MAX_TOOLS = 128;
const MAX_RESULT = 64 * 1024;
const SHELLS = new Set(['cmd', 'command', 'powershell', 'pwsh', 'wscript', 'cscript', 'mshta', 'bash', 'sh', 'zsh', 'fish']);
const realpath = fs.realpathSync.native || fs.realpathSync;

export interface McpServerConfig {
  id: string;
  name?: string;
  transport: 'stdio' | 'http';
  enabled?: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: { [name: string]: string };
  url?: string;
  headers?: { [name: string]: string };
  timeoutMs?: number;
}
export interface McpStatus {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  error?: string;
  protocolVersion?: string;
  serverInfo?: { name: string; version: string };
}

function record(value: any): boolean { return !!value && typeof value === 'object' && !Array.isArray(value); }
function string(value: any, limit: number, label: string): string {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0')) throw new Error('Invalid MCP ' + label + '.');
  return value;
}
function pairs(input: any, kind: 'env' | 'headers'): { [key: string]: string } | undefined {
  if (input === undefined) return undefined;
  if (!record(input) || Object.keys(input).length > 64) throw new Error('MCP ' + kind + ' must be a string map with at most 64 entries.');
  const output: { [key: string]: string } = Object.create(null);
  for (const key of Object.keys(input)) {
    if (!(kind === 'env' ? /^[A-Za-z_][A-Za-z0-9_]*$/ : /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).test(key)) throw new Error('Invalid MCP ' + kind + ' key.');
    const value = string(input[key], 8192, kind + ' value');
    if (kind === 'headers' && /[\x00-\x08\x0a-\x1f\x7f\u0100-\uffff]/.test(value)) throw new Error('MCP headers contain invalid characters.');
    if (kind === 'headers' && ['host', 'content-length', 'content-type', 'accept', 'connection', 'transfer-encoding', 'mcp-session-id', 'mcp-protocol-version'].includes(key.toLowerCase())) throw new Error('MCP transport header cannot be overridden: ' + key);
    output[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(output)) > 64 * 1024) throw new Error('MCP ' + kind + ' exceeds 64 KiB.');
  return output;
}
function absoluteLocal(value: any, label: string): string {
  const text = string(value, 4096, label);
  if (!path.isAbsolute(text) || /^[\\/]{2}/.test(text) || /[\x00-\x1f<>"|?*]/.test(text) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(text))) throw new Error('MCP ' + label + ' must be an absolute local path.');
  return path.resolve(text);
}

export function validateMcpConfig(input: unknown): McpServerConfig[] {
  let entries: any[];
  if (Array.isArray(input)) entries = input;
  else if (record(input) && record((input as any).mcpServers)) {
    const servers = (input as any).mcpServers;
    entries = Object.keys(servers).map(id => ({ ...servers[id], id }));
  } else throw new Error('MCP configuration must be an array or {"mcpServers":{...}}.');
  if (entries.length > 16) throw new Error('At most 16 MCP servers can be configured.');
  const ids = new Set<string>();
  return entries.map(entry => {
    if (!record(entry) || !/^[a-zA-Z0-9_-]{1,40}$/.test(entry.id || '')) throw new Error('MCP server id must contain 1–40 letters, digits, underscores or hyphens.');
    if (ids.has(entry.id)) throw new Error('Duplicate MCP server id: ' + entry.id);
    ids.add(entry.id);
    const transport = entry.transport || (entry.url ? 'http' : 'stdio');
    if (transport !== 'stdio' && transport !== 'http') throw new Error('Supported MCP transports are stdio and http (Streamable HTTP).');
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error('MCP enabled must be boolean.');
    const timeoutMs = entry.timeoutMs === undefined ? 30000 : entry.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error('MCP timeoutMs must be between 100 and 120000.');
    const config: McpServerConfig = { id: entry.id, name: entry.name === undefined ? entry.id : string(entry.name, 100, 'name'), transport, enabled: entry.enabled !== false, timeoutMs };
    if (transport === 'http') {
      const url = new URL(string(entry.url, 8192, 'URL'));
      if (url.username || url.password || url.hash) throw new Error('MCP URL cannot contain credentials or a fragment; use headers for credentials.');
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Remote MCP servers require HTTPS; local servers may use HTTP.');
      config.url = url.href;
      config.headers = pairs(entry.headers, 'headers');
    } else {
      config.command = absoluteLocal(entry.command, 'command');
      const base = path.basename(config.command).replace(/\.[^.]+$/, '').toLowerCase();
      if (SHELLS.has(base) || /\.(cmd|bat|ps1|vbs|js|sh)$/i.test(config.command) || (process.platform === 'win32' && path.extname(config.command).toLowerCase() !== '.exe')) throw new Error('MCP stdio requires a direct executable, not a shell or script launcher. For Node servers use an absolute node.exe path and script args.');
      if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.length > 128)) throw new Error('MCP args must be an array of at most 128 literal arguments.');
      config.args = (entry.args || []).map((value: any) => string(value, 8192, 'argument'));
      if (entry.cwd !== undefined) config.cwd = absoluteLocal(entry.cwd, 'cwd');
      config.env = pairs(entry.env, 'env');
    }
    return config;
  });
}

function configuredSecrets(config: McpServerConfig): string[] {
  const secrets = [...Object.values(config.headers || {}), ...Object.values(config.env || {}), process.env.PI_API_KEY || ''].filter(value => value.length > 0);
  for (const value of Object.values(config.headers || {})) {
    const auth = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value);
    if (auth) secrets.push(auth[1]);
  }
  if (config.url) {
    const url = new URL(config.url);
    url.searchParams.forEach(value => { if (value.length > 0) secrets.push(value); });
  }
  return secrets.sort((a, b) => b.length - a.length);
}
function scrubber(config: McpServerConfig): (value: unknown) => string {
  const secrets = configuredSecrets(config);
  return value => {
    let text = value instanceof Error ? value.message : String(value);
    for (const secret of secrets) text = text.split(secret).join('[redacted]');
    return text.slice(0, 2000);
  };
}

function message(input: any): any[] {
  const items = Array.isArray(input) ? input : [input];
  if (!items.length || items.length > 128) throw new Error('Invalid MCP message batch.');
  for (const item of items) {
    if (!record(item) || item.jsonrpc !== '2.0') throw new Error('Invalid MCP JSON-RPC message.');
    if (item.method !== undefined && typeof item.method !== 'string') throw new Error('Invalid MCP method.');
  }
  return items;
}

function response(item: any): any {
  if (item.error !== undefined && Object.prototype.hasOwnProperty.call(item, 'result')) throw new Error('MCP response cannot contain both result and error.');
  if (item.error !== undefined) throw new Error('MCP error ' + String(item.error && item.error.code) + ': ' + String(item.error && item.error.message));
  if (!Object.prototype.hasOwnProperty.call(item, 'result')) throw new Error('MCP response has no result.');
  return item.result;
}

interface Transport {
  request(method: string, params?: any, signal?: CancellationSignal): Promise<any>;
  notify(method: string, params?: any, signal?: CancellationSignal): Promise<void>;
  close(): Promise<void>;
  protocolVersion?: string;
}

class StdioTransport implements Transport {
  private child: ChildProcess;
  private id = 0;
  private closed = false;
  private exited = false;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: any) => void; cleanup: () => void }>();
  private clean: (value: unknown) => string;
  constructor(private config: McpServerConfig, workspace: string) {
    this.clean = scrubber(config);
    const command = realpath(config.command!);
    if (!fs.statSync(command).isFile() || SHELLS.has(path.basename(command).replace(/\.[^.]+$/, '').toLowerCase())) throw new Error('MCP command must be a direct executable file.');
    const cwd = realpath(config.cwd || workspace);
    if (!fs.statSync(cwd).isDirectory()) throw new Error('MCP cwd must be a directory.');
    // Servers receive normal OS environment but no ambient API keys or tokens.
    // Explicit env entries are intentional server credentials supplied by users.
    const env: NodeJS.ProcessEnv = {};
    for (const key of Object.keys(process.env)) if (!/(?:API_?KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|COOKIE|AUTH)/i.test(key)) env[key] = process.env[key];
    for (const key of Object.keys(config.env || {})) if (key.toUpperCase() !== 'PI_API_KEY') env[key] = config.env![key];
    this.child = spawn(command, config.args || [], { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', error => this.fail(error));
    this.child.stdin!.on('error', error => this.fail(error));
    this.child.on('close', () => { this.exited = true; this.fail(new Error('MCP process exited.')); });
    // Drain stderr without echoing credential-bearing server logs into the UI.
    this.child.stderr!.on('data', () => {});
    const decoder = new StringDecoder('utf8');
    let buffered = '';
    this.child.stdout!.on('data', (chunk: Buffer) => {
      if (this.closed) return;
      buffered += decoder.write(chunk);
      if (Buffer.byteLength(buffered, 'utf8') > MAX_MESSAGE) { this.fail(new Error('MCP message exceeds 2 MiB.')); return; }
      let index: number;
      while ((index = buffered.indexOf('\n')) >= 0 && !this.closed) {
        const line = buffered.slice(0, index).replace(/\r$/, ''); buffered = buffered.slice(index + 1);
        if (!line.trim()) continue;
        try { for (const item of message(JSON.parse(line))) this.receive(item); }
        catch (error) { this.fail(error); }
      }
    });
  }
  private receive(item: any): void {
    if (item.method !== undefined) {
      if (item.id !== undefined) this.send({ jsonrpc: '2.0', id: item.id, ...(item.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Client method not supported' } }) }).catch(() => {});
      return;
    }
    const pending = this.pending.get(item.id);
    if (!pending) return; // A cancelled request can still finish on the server.
    this.pending.delete(item.id); pending.cleanup();
    try { pending.resolve(response(item)); } catch (error) { pending.reject(new Error(this.clean(error))); }
  }
  private fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new Error(this.clean(error))); }
    this.pending.clear();
    try { this.child.stdin!.end(); this.child.kill(); } catch (_) { /* already closed */ }
  }
  private send(body: any): Promise<void> {
    if (this.closed) return Promise.reject(new Error('MCP connection is closed.'));
    const line = JSON.stringify(body) + '\n';
    if (Buffer.byteLength(line) > MAX_MESSAGE) return Promise.reject(new Error('MCP request exceeds 2 MiB.'));
    return new Promise((resolve, reject) => this.child.stdin!.write(line, error => error ? reject(new Error(this.clean(error))) : resolve()));
  }
  request(method: string, params?: any, signal?: CancellationSignal): Promise<any> {
    if (signal && signal.aborted) return Promise.reject(new Error('MCP request cancelled.'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const cancel = (reason: string) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id); entry.cleanup();
        if (method !== 'initialize') this.notify('notifications/cancelled', { requestId: id, reason }).catch(() => {});
        reject(new Error(reason));
      };
      const abort = () => cancel('MCP request cancelled.');
      const timer = setTimeout(() => cancel('MCP request timed out.'), this.config.timeoutMs);
      const cleanup = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve, reject, cleanup });
      if (signal) signal.addEventListener('abort', abort, { once: true });
      this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }).catch(error => {
        if (this.pending.delete(id)) { cleanup(); reject(error); }
      });
    });
  }
  notify(method: string, params?: any, signal?: CancellationSignal): Promise<void> {
    if (signal && signal.aborted) return Promise.reject(new Error('MCP request cancelled.'));
    return this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }
  async close(): Promise<void> {
    this.fail(new Error('MCP connection closed.'));
    if (!this.exited) await new Promise<void>(resolve => {
      const timer = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch (_) {} this.child.stdout!.destroy(); this.child.stderr!.destroy(); resolve(); }, 500);
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }
}

class HttpTransport implements Transport {
  private id = 0;
  private closed = false;
  private session = '';
  private requests = new Set<http.ClientRequest>();
  protocolVersion?: string;
  private clean: (value: unknown) => string;
  constructor(private config: McpServerConfig) { this.clean = scrubber(config); }
  private post(body: any, signal?: CancellationSignal): Promise<any> {
    if (this.closed) return Promise.reject(new Error('MCP connection is closed.'));
    if (signal && signal.aborted) return Promise.reject(new Error('MCP request cancelled.'));
    const expected = body.id !== undefined && typeof body.method === 'string' ? body.id : undefined;
    const data = JSON.stringify(body);
    if (Buffer.byteLength(data) > MAX_MESSAGE) return Promise.reject(new Error('MCP request exceeds 2 MiB.'));
    const url = new URL(this.config.url!);
    const headers: { [key: string]: string | number } = { ...this.config.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(data) };
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
    return new Promise((resolve, reject) => {
      let done = false, responseStream: http.IncomingMessage | undefined;
      let request: http.ClientRequest;
      const finish = (error?: unknown, result?: any) => {
        if (done) return; done = true;
        clearTimeout(timer); this.requests.delete(request);
        if (signal) signal.removeEventListener('abort', abort);
        if (responseStream) responseStream.destroy();
        if (request) request.destroy();
        error ? reject(new Error(this.clean(error))) : resolve(result);
      };
      const cancel = (reason: string) => {
        if (done) return;
        if (expected !== undefined && body.method !== 'initialize') this.notify('notifications/cancelled', { requestId: expected, reason }).catch(() => {});
        finish(new Error(reason));
      };
      const abort = () => cancel('MCP request cancelled.');
      const timer = setTimeout(() => cancel('MCP request timed out.'), this.config.timeoutMs);
      const receive = (parsed: any) => {
        for (const item of message(parsed)) {
          if (item.method !== undefined) {
            if (item.id !== undefined) this.post({ jsonrpc: '2.0', id: item.id, ...(item.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Client method not supported' } }) }).catch(() => {});
          } else if (expected !== undefined && item.id === expected) { finish(undefined, response(item)); return; }
        }
      };
      try { request = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', headers }, incoming => {
        responseStream = incoming;
        if (incoming.statusCode! < 200 || incoming.statusCode! >= 300) {
          finish(new Error('MCP HTTP ' + incoming.statusCode + (incoming.statusCode === 404 && this.session ? ': session expired; reconnect explicitly (tool calls are not replayed).' : '. Redirects and legacy HTTP+SSE are not supported.'))); return;
        }
        const session = incoming.headers['mcp-session-id'];
        if (body.method === 'initialize' && session !== undefined) {
          if (typeof session !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(session)) { finish(new Error('Invalid MCP session id.')); return; }
          this.session = session;
        }
        if (expected === undefined) { incoming.resume(); finish(); return; }
        const mime = String(incoming.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (mime !== 'application/json' && mime !== 'text/event-stream') { finish(new Error('MCP response must be JSON or an SSE stream.')); return; }
        let bytes = 0, buffer = '';
        const decoder = new StringDecoder('utf8');
        const parseEvents = () => {
          let match: RegExpExecArray | null;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
            const lines = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, ''));
            if (lines.length) receive(JSON.parse(lines.join('\n')));
            if (done) break;
          }
        };
        incoming.on('data', (chunk: Buffer) => {
          if (done) return;
          bytes += chunk.length;
          if (bytes > MAX_MESSAGE) { finish(new Error('MCP response exceeds 2 MiB.')); return; }
          buffer += decoder.write(chunk);
          try { if (mime === 'text/event-stream') parseEvents(); } catch (error) { finish(error); }
        });
        incoming.on('end', () => {
          if (done) return;
          buffer += decoder.end();
          try {
            if (mime === 'application/json') receive(JSON.parse(buffer));
            else parseEvents();
            if (!done) finish(new Error('MCP response ended without a matching JSON-RPC response id.'));
          } catch (error) { finish(error); }
        });
        incoming.on('aborted', () => finish(new Error('MCP response was interrupted.')));
        incoming.on('error', error => finish(error));
      }); } catch (error) { finish(error); return; }
      this.requests.add(request);
      request.on('error', error => finish(error));
      if (signal) signal.addEventListener('abort', abort, { once: true });
      request.end(data);
    });
  }
  request(method: string, params?: any, signal?: CancellationSignal): Promise<any> { return this.post({ jsonrpc: '2.0', id: ++this.id, method, ...(params === undefined ? {} : { params }) }, signal); }
  async notify(method: string, params?: any, signal?: CancellationSignal): Promise<void> { await this.post({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }, signal); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.requests) request.destroy(new Error('MCP connection closed.'));
    this.requests.clear();
    if (!this.session) return;
    const url = new URL(this.config.url!);
    await new Promise<void>(resolve => {
      const request = (url.protocol === 'https:' ? https : http).request(url, { method: 'DELETE', headers: { ...this.config.headers, 'Mcp-Session-Id': this.session, ...(this.protocolVersion ? { 'MCP-Protocol-Version': this.protocolVersion } : {}) } }, response => { response.resume(); resolve(); });
      const timer = setTimeout(() => { request.destroy(); resolve(); }, 1000);
      request.on('error', () => { clearTimeout(timer); resolve(); });
      request.on('close', () => clearTimeout(timer));
      request.end();
    });
  }
}

class McpConnection {
  transport: Transport;
  tools: any[] = [];
  info: any;
  private clean: (value: unknown) => string;
  constructor(public config: McpServerConfig, workspace: string) {
    this.clean = scrubber(config);
    this.transport = config.transport === 'http' ? new HttpTransport(config) : new StdioTransport(config, workspace);
  }
  async connect(signal?: CancellationSignal): Promise<void> {
    this.info = await this.transport.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'pi-win7-web', version: '0.3.0' } }, signal);
    const versions = this.config.transport === 'stdio' ? [PROTOCOL, '2024-11-05'] : [PROTOCOL];
    if (!record(this.info) || !versions.includes(this.info.protocolVersion) || !record(this.info.capabilities)) throw new Error('MCP server negotiated an unsupported protocol version or invalid capabilities. Supported: ' + versions.join(', '));
    this.transport.protocolVersion = this.info.protocolVersion;
    await this.transport.notify('notifications/initialized', undefined, signal);
    if (this.info.capabilities.tools) await this.refreshTools(signal);
  }
  async refreshTools(signal?: CancellationSignal): Promise<void> {
    if (!this.info.capabilities.tools) return;
    const output: any[] = [], names = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.transport.request('tools/list', cursor ? { cursor } : {}, signal);
      if (!record(result) || !Array.isArray(result.tools)) throw new Error('Invalid MCP tools/list result.');
      for (const tool of result.tools) {
        if (!record(tool) || typeof tool.name !== 'string' || !tool.name || tool.name.length > 128 || /[\x00-\x1f]/.test(tool.name) || !record(tool.inputSchema) || tool.inputSchema.type !== 'object') throw new Error('Invalid MCP tool definition.');
        if (names.has(tool.name)) throw new Error('Duplicate MCP tool name.');
        if (Buffer.byteLength(JSON.stringify(tool)) > 128 * 1024) throw new Error('MCP tool definition exceeds 128 KiB.');
        names.add(tool.name); output.push(tool);
        if (output.length > MAX_TOOLS) throw new Error('MCP server exposes more than 128 tools.');
      }
      cursor = result.nextCursor;
      if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || cursors.has(cursor))) throw new Error('Invalid or repeated MCP pagination cursor.');
      if (cursor) cursors.add(cursor);
      if (cursors.size > 32) throw new Error('MCP tool pagination exceeds 32 pages.');
    } while (cursor);
    this.tools = output;
  }
  async call(name: string, args: any, signal?: CancellationSignal): Promise<any> {
    try {
      const result = await this.transport.request('tools/call', { name, arguments: args }, signal);
      if (!record(result) || !Array.isArray(result.content)) throw new Error('Invalid MCP tools/call result.');
      let text = '';
      for (const block of result.content) {
        if (!record(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') text += block.text + '\n';
        else if (block.type === 'resource' && record(block.resource) && typeof block.resource.text === 'string') text += block.resource.text + '\n';
        else if (block.type === 'resource_link') text += '[MCP resource link: ' + String(block.name || '') + ' — ' + String(block.uri || '') + ']\n';
        else text += '[MCP ' + String(block.type || 'unknown') + ' content omitted: this client supports text output.]\n';
      }
      if (result.structuredContent !== undefined) text += JSON.stringify(result.structuredContent, null, 2) + '\n';
      // Redact credentials even if a server accidentally echoes them in a result.
      const secretClean = scrubber(this.config);
      // scrubber limits errors to 2000 chars; result redaction must preserve its
      // independent 64 KiB output limit, so mask credentials before truncation.
      for (const secret of configuredSecrets(this.config)) text = text.split(secret).join('[redacted]');
      const bounded = truncateHead(text, { maxLines: 2000, maxBytes: MAX_RESULT });
      const truncated = bounded.truncated;
      text = bounded.content;
      if (truncated) text += bounded.firstLineExceedsLimit
        ? '\n[MCP output truncated: the first line exceeds 64 KiB. Request a smaller or paginated result.]'
        : '\n[MCP output truncated at ' + (bounded.truncatedBy === 'lines' ? '2000 lines' : '64 KiB') + '.]';
      if (result.isError) throw new Error('MCP tool failed: ' + secretClean(text));
      return { content: [{ type: 'text', text: text || '(MCP tool returned no text.)' }], details: { mcpServerId: this.config.id, mcpToolName: name, truncated, truncatedBy: bounded.truncatedBy, outputBytes: bounded.outputBytes, outputLines: bounded.outputLines } };
    } catch (error) { throw new Error(this.clean(error)); }
  }
  agentTools(): any[] {
    return this.tools.map(tool => ({
      name: 'mcp_' + this.config.id.slice(0, 24) + '_' + tool.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20) + '_' + crypto.createHash('sha256').update(this.config.id + '\0' + tool.name).digest('hex').slice(0, 8),
      label: (this.config.name || this.config.id) + ' · ' + tool.name,
      description: ('MCP server ' + this.config.id + ', tool ' + tool.name + '. ' + String(tool.description || '')).slice(0, 8000),
      parameters: tool.inputSchema,
      mcpServerId: this.config.id,
      mcpToolName: tool.name,
      // Annotation hints are not trusted for permission decisions.
      execute: (_id: string, args: any, signal?: CancellationSignal) => this.call(tool.name, args, signal)
    }));
  }
}

export class McpManager {
  private configs: McpServerConfig[];
  private connections = new Map<string, McpConnection>();
  private statuses: McpStatus[];
  constructor(configs: McpServerConfig[] | unknown, private workspace: string) {
    this.configs = validateMcpConfig(configs);
    this.statuses = this.configs.map(config => ({ id: config.id, name: config.name || config.id, transport: config.transport, enabled: config.enabled !== false, connected: false, toolCount: 0 }));
  }
  async connect(signal?: CancellationSignal): Promise<McpStatus[]> {
    await Promise.all(this.configs.map(async (config, index) => {
      if (config.enabled === false || this.connections.has(config.id)) return;
      let connection: McpConnection | undefined;
      try {
        connection = new McpConnection(config, this.workspace);
        await connection.connect(signal);
        this.connections.set(config.id, connection);
        const info = connection.info.serverInfo || {};
        this.statuses[index] = { ...this.statuses[index], connected: true, toolCount: connection.tools.length, error: undefined, protocolVersion: connection.info.protocolVersion, serverInfo: { name: String(info.name || '').slice(0, 200), version: String(info.version || '').slice(0, 100) } };
      } catch (error) {
        if (connection) await connection.transport.close();
        this.statuses[index] = { ...this.statuses[index], connected: false, toolCount: 0, error: scrubber(config)(error) };
      }
    }));
    return this.status();
  }
  status(): McpStatus[] { return this.statuses.map(item => ({ ...item })); }
  async createTools(signal?: CancellationSignal): Promise<any[]> {
    await this.connect(signal);
    return Array.from(this.connections.values()).reduce((tools, connection) => tools.concat(connection.agentTools()), [] as any[]);
  }
  async close(): Promise<void> {
    const connections = Array.from(this.connections.values()); this.connections.clear();
    await Promise.all(connections.map(connection => connection.transport.close()));
    this.statuses = this.statuses.map(status => ({ ...status, connected: false, toolCount: 0 }));
  }
}

export async function testMcpServer(config: McpServerConfig, workspace: string, signal?: CancellationSignal): Promise<any> {
  const manager = new McpManager([{ ...config, enabled: true }], workspace);
  try {
    const tools = await manager.createTools(signal);
    return { ...manager.status()[0], tools: tools.map(tool => ({ name: tool.mcpToolName, description: tool.description })) };
  } finally { await manager.close(); }
}
