'use strict';

// Run this script with the bundled runtime/node.exe using MCP stdio.
// Node 12 compatible, no npm install, no shell and no network required.
const readline = require('readline');
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
input.on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch (_) { return; }
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = {
    protocolVersion: '2025-03-26', capabilities: { tools: {} },
    serverInfo: { name: 'pi-win7-demo', version: '1.0.0' }
  };
  else if (request.method === 'tools/list') result = { tools: [
    { name: 'echo', description: 'Return the supplied text. Use this to test an MCP call.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
    { name: 'add', description: 'Add two numbers. Use this to test MCP tool arguments.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false } }
  ] };
  else if (request.method === 'tools/call') {
    const args = request.params.arguments || {};
    if (request.params.name === 'echo' && typeof args.text === 'string') result = { content: [{ type: 'text', text: args.text }] };
    else if (request.params.name === 'add' && typeof args.a === 'number' && typeof args.b === 'number') result = { content: [{ type: 'text', text: String(args.a + args.b) }] };
    else result = { isError: true, content: [{ type: 'text', text: 'Invalid tool or arguments.' }] };
  } else if (request.method === 'ping') result = {};
  else { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }); return; }
  send({ jsonrpc: '2.0', id: request.id, result });
});
