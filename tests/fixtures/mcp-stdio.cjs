'use strict';
const readline = require('readline');
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test-fixture', version: '1' } };
  else if (request.method === 'tools/list') result = request.params.cursor ? { tools: [{ name: 'second', inputSchema: { type: 'object', properties: {} } }] } : { tools: [{ name: 'test', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }], nextCursor: 'page-2' };
  else if (request.method === 'tools/call') {
    const args = request.params.arguments || {};
    if (args.wait) return;
    if (args.malformed) { process.stdout.write('not-json\n'); return; }
    if (args.echoSecret) { send({ jsonrpc: '2.0', id: request.id, error: { code: -1, message: process.env.DEMO_SECRET } }); return; }
    result = { content: [{ type: 'text', text: args.large ? '中'.repeat(100000) : args.manyLines ? '完整行\n'.repeat(2100) : JSON.stringify({ text: args.text || '', piKey: process.env.PI_API_KEY || null, explicit: process.env.DEMO_SECRET || null }) }] };
  } else if (request.method === 'ping') result = {};
  else { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }); return; }
  send({ jsonrpc: '2.0', id: request.id, result });
});
