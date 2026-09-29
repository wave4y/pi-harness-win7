'use strict';

// Bounded integration checks that also run with the shipped Node 12 runtime.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const AbortController = require('abort-controller');
const { validateMcpConfig, McpManager, testMcpServer } = require('../dist/mcp.cjs');
const { discoverSkills, readSkill, createSkillTools, skillPrompt } = require('../dist/skills.cjs');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(root, '.test-tmp', 'mcp-skills-'));
const fixture = path.join(__dirname, 'fixtures', 'mcp-stdio.cjs');

function makeSkill(directory, name, description) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + description + '\n---\n\nInstructions.\n');
}

async function skillsTest() {
  const workspace = path.join(scratch, 'workspace');
  const extra = path.join(scratch, 'shared-skills');
  const skillDir = path.join(workspace, '.agents', 'skills', 'nested', 'first');
  makeSkill(skillDir, 'first-skill', '>\n  A folded\n  description.');
  fs.writeFileSync(path.join(skillDir, 'support.txt'), '支持文件');
  makeSkill(path.join(workspace, '.pi', 'skills', 'second'), 'second-skill', '"Pi convention"');
  makeSkill(path.join(extra, 'duplicate'), 'first-skill', 'duplicate ignored');
  makeSkill(path.join(extra, 'third'), 'shared-skill', "'Shared skill'");
  fs.mkdirSync(path.join(extra, 'bad'), { recursive: true });
  fs.writeFileSync(path.join(extra, 'bad', 'SKILL.md'), 'No frontmatter');
  const catalog = discoverSkills(workspace, [extra]);
  assert.deepStrictEqual(catalog.skills.map(skill => skill.name), ['first-skill', 'second-skill', 'shared-skill']);
  assert.strictEqual(catalog.skills[0].description, 'A folded description.');
  assert(catalog.warnings.some(warning => warning.includes('Duplicate')));
  assert(catalog.warnings.some(warning => warning.includes('frontmatter')));
  assert(readSkill(catalog.skills[0]).content.includes('Instructions.'));
  assert.strictEqual(readSkill(catalog.skills[0], 'support.txt').content, '支持文件');
  for (const invalid of ['../other', '../../SKILL.md', '..\\outside', path.join(scratch, 'outside.txt'), 'support.txt:secret', '\\server\file', null]) assert.throws(() => readSkill(catalog.skills[0], invalid));
  fs.writeFileSync(path.join(scratch, 'secret.txt'), 'OUTSIDE');
  const link = path.join(skillDir, 'escape');
  try {
    fs.symlinkSync(scratch, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => readSkill(catalog.skills[0], 'escape/secret.txt'), /outside/);
  } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
  fs.writeFileSync(path.join(skillDir, 'binary'), Buffer.from([0, 255]));
  assert.throws(() => readSkill(catalog.skills[0], 'binary'), /binary/);
  const tools = createSkillTools(catalog.skills);
  const result = await tools[0].execute('1', { skill: 'first-skill', path: 'support.txt' });
  assert.strictEqual(result.content[0].text, '支持文件');
  await assert.rejects(tools[0].execute('1', { skill: 'missing' }), /Unknown/);
  assert(skillPrompt(catalog.skills).includes('first-skill'));
  assert.strictEqual(fs.readFileSync(path.join(scratch, 'secret.txt'), 'utf8'), 'OUTSIDE');
  console.log('PASS Skills discovery, metadata, support files, duplicates and containment.');
}

async function stdioTest() {
  const config = validateMcpConfig({ mcpServers: { demo: { command: process.execPath, args: [fixture], timeoutMs: 1000, env: { DEMO_SECRET: 'sentinel-private-value' } } } });
  assert.strictEqual(config[0].transport, 'stdio');
  for (const value of [
    [{ id: 'bad id', command: process.execPath }],
    [{ id: 'bad', command: 'node' }],
    [{ id: 'bad', command: path.join(path.dirname(process.execPath), 'cmd.exe') }],
    [{ id: 'bad', url: 'http://example.com/mcp' }],
    [{ id: 'bad', url: 'https://example.com/mcp', headers: { Host: 'evil' } }],
    [{ id: 'bad', url: 'https://example.com/mcp', headers: { Authorization: 'a\r\nb' } }]
  ]) assert.throws(() => validateMcpConfig(value));
  const oldKey = process.env.PI_API_KEY;
  process.env.PI_API_KEY = 'ambient-provider-secret';
  const manager = new McpManager(config, scratch);
  try {
    const tools = await manager.createTools();
    assert.strictEqual(tools.length, 2);
    assert.strictEqual(manager.status()[0].connected, true);
    assert.strictEqual(manager.status()[0].protocolVersion, '2025-03-26');
    const test = tools.find(tool => tool.mcpToolName === 'test');
    assert(!test.readOnlyHint);
    const result = await test.execute('1', { text: '你好' });
    const value = JSON.parse(result.content[0].text);
    assert.strictEqual(value.text, '你好');
    assert.strictEqual(value.piKey, null);
    assert.strictEqual(value.explicit, '[redacted]');
    const large = await test.execute('1', { large: true });
    assert.strictEqual(large.details.truncated, true);
    assert.strictEqual(large.details.truncatedBy, 'bytes');
    assert(large.content[0].text.includes('first line exceeds 64 KiB'));
    assert(!large.content[0].text.includes('\ufffd'));
    const manyLines = await test.execute('1', { manyLines: true });
    assert.strictEqual(manyLines.details.truncatedBy, 'lines');
    assert.strictEqual(manyLines.details.outputLines, 2000);
    assert(manyLines.content[0].text.includes('完整行\n完整行'));
    assert(manyLines.content[0].text.endsWith('[MCP output truncated at 2000 lines.]'));
    await assert.rejects(test.execute('1', { echoSecret: true }), error => !error.message.includes('sentinel-private-value') && error.message.includes('[redacted]'));
    const controller = new AbortController();
    const waiting = test.execute('1', { wait: true }, controller.signal);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(waiting, /cancelled/);
    await assert.rejects(test.execute('1', { wait: true }), /timed out/);
    assert((await test.execute('1', { text: 'after cancellation' })).content[0].text.includes('after cancellation'));
    await assert.rejects(test.execute('1', { malformed: true }), /JSON|Unexpected|token/i);
  } finally {
    await manager.close();
    if (oldKey === undefined) delete process.env.PI_API_KEY; else process.env.PI_API_KEY = oldKey;
  }
  const demo = await testMcpServer({ id: 'bundled', transport: 'stdio', command: process.execPath, args: [path.join(root, 'examples', 'mcp-demo-server.cjs')] }, scratch);
  assert.strictEqual(demo.connected, true);
  assert.deepStrictEqual(demo.tools.map(tool => tool.name), ['echo', 'add']);
  console.log('PASS MCP stdio initialization, pagination, actual tool calls, redaction, output limit, abort, timeout and bundled demo.');
}

async function httpTest() {
  const calls = [];
  let cancelled = false, deleted = false;
  const server = http.createServer((request, reply) => {
    if (request.method === 'DELETE') { deleted = true; reply.writeHead(204); reply.end(); return; }
    let body = '';
    request.on('data', chunk => body += chunk);
    request.on('end', () => {
      const message = JSON.parse(body); calls.push(message.method);
      if (message.method !== 'initialize') assert.strictEqual(request.headers['mcp-session-id'], 'test-session');
      if (request.url === '/redirect') { reply.writeHead(302, { Location: '/mcp' }); reply.end(); return; }
      if (message.method === 'initialize') {
        reply.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'test-session' });
        reply.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'http-fixture', version: '1' } } }));
      } else if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
        if (request.url === '/init-notify-hang' && message.method === 'notifications/initialized') return;
        if (message.method === 'notifications/cancelled') cancelled = true;
        reply.writeHead(202); reply.end();
      } else if (message.method === 'tools/list') {
        assert.strictEqual(request.headers['mcp-protocol-version'], '2025-03-26');
        reply.writeHead(200, { 'Content-Type': 'application/json' });
        reply.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] } }));
      } else if (message.method === 'tools/call') {
        if (message.params.arguments.wait) { reply.on('close', () => {}); return; }
        if (message.params.arguments.huge) { reply.writeHead(200, { 'Content-Type': 'text/event-stream' }); reply.end('data: ' + 'x'.repeat(3 * 1024 * 1024)); return; }
        if (message.params.arguments.wrongId) { reply.writeHead(200, { 'Content-Type': 'application/json' }); reply.end(JSON.stringify({ jsonrpc: '2.0', id: 987654321, result: {} })); return; }
        reply.writeHead(200, { 'Content-Type': 'text/event-stream' });
        reply.write(': heartbeat\r\n\r\n');
        reply.write('data: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }) + '\r\n\r\n');
        const bytes = Buffer.from('data: ' + JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '中文 SSE response' }] } }) + '\r\n\r\n');
        const index = bytes.indexOf(Buffer.from('中文')) + 1;
        reply.write(bytes.slice(0, index)); setTimeout(() => reply.end(bytes.slice(index)), 5);
      } else { reply.writeHead(202); reply.end(); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const manager = new McpManager([{ id: 'http', transport: 'http', url: url + '/mcp', timeoutMs: 1000 }], scratch);
  try {
    const tools = await manager.createTools();
    assert.strictEqual(tools.length, 1);
    assert.strictEqual((await tools[0].execute('1', {})).content[0].text.trim(), '中文 SSE response');
    await assert.rejects(tools[0].execute('1', { wrongId: true }), /matching JSON-RPC response id/);
    await assert.rejects(tools[0].execute('1', { huge: true }), /exceeds 2 MiB/);
    const controller = new AbortController();
    const waiting = tools[0].execute('1', { wait: true }, controller.signal);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(waiting, /cancelled/);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.strictEqual(cancelled, true);
    const initializing = new McpManager([{ id: 'initializing', transport: 'http', url: url + '/init-notify-hang', timeoutMs: 30000 }], scratch);
    const initializeAbort = new AbortController();
    const start = Date.now();
    const initializingTools = initializing.createTools(initializeAbort.signal);
    setTimeout(() => initializeAbort.abort(), 50);
    assert.deepStrictEqual(await initializingTools, []);
    assert(initializing.status()[0].error.includes('cancelled'));
    assert(Date.now() - start < 2000, 'Cancellation must interrupt notifications/initialized HTTP wait.');
    await initializing.close();
    const redirected = await testMcpServer({ id: 'redirect', transport: 'http', url: url + '/redirect' }, scratch);
    assert.strictEqual(redirected.connected, false);
    assert(redirected.error.includes('302'));
    await manager.close();
    assert.strictEqual(deleted, true);
  } finally { await manager.close(); await new Promise(resolve => server.close(resolve)); }
  assert.deepStrictEqual(calls.slice(0, 3), ['initialize', 'notifications/initialized', 'tools/list']);
  console.log('PASS MCP HTTP JSON/SSE, UTF-8 boundaries, session headers, cancellation, matching ids, no redirects and session DELETE.');
}

(async () => { await skillsTest(); await stdioTest(); await httpTest(); console.log('All MCP and Skills tests passed.'); })().catch(error => { console.error(error); process.exitCode = 1; });
