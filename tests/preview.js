'use strict';
// Explicit offline mock provider for interactive UI testing. Not included in releases.
const http = require('http');
const fs = require('fs');
const path = require('path');
const spawn = require('child_process').spawn;
const root = path.resolve(__dirname, '..');
const fixture = process.env.PI_PREVIEW_NAME || 'ui';
if (!/^[a-z0-9-]+$/.test(fixture)) throw new Error('Invalid preview fixture name');
const mockPort = Number(process.env.PI_PREVIEW_MODEL_PORT || '3091');
const webPort = Number(process.env.PI_PREVIEW_PORT || '3092');
const workspace = path.join(root, '.test-tmp', fixture + '-workspace');
fs.mkdirSync(workspace, {recursive: true});
fs.mkdirSync(path.join(workspace, '子项目'), {recursive: true});
fs.writeFileSync(path.join(workspace, '子项目', 'readme.txt'), '这是用于测试文件夹选择的子目录。\n');
fs.writeFileSync(path.join(workspace, 'hello.txt'), '你好，Pi。\r\n这是一份 Web 工具验证文件。\r\n');
const mock = http.createServer((req, res) => {
  let body = ''; req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const data = JSON.parse(body); const last = data.messages[data.messages.length - 1];
    if (last.role === 'user' && JSON.stringify(last.content).includes('UI_TEST_FAILURE')) { res.writeHead(400, {'Content-Type': 'application/json'}); res.end(JSON.stringify({error: {message: '离线模拟请求失败（用于验证刷新后的错误历史）', type: 'invalid_request_error'}})); return; }
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    const event = payload => res.write('data: ' + JSON.stringify({choices: [payload]}) + '\n\n');
    if (!Array.isArray(data.tools) || !data.tools.length) {
      event({delta: {content: '离线摘要：用户在 Win7 Web 适配测试中读取了 hello.txt，并验证了文件修改权限。保留继续验证本地工具、MCP 与 Skills 的任务。'}, finish_reason: 'stop'});
    } else if (last.role === 'user' && JSON.stringify(last.content).includes('UI_TEST_PERSIST')) {
      event({delta: {content: '离线验证：这条回复用于检查历史记录与设置在重启后恢复。'}, finish_reason: 'stop'});
    } else if (last.role === 'user') {
      event({delta: {tool_calls: [{index: 0, id: 'preview-read', type: 'function', function: {name: 'read_file', arguments: '{"path":"hello.txt"}'}}]}, finish_reason: 'tool_calls'});
    } else if (last.tool_call_id === 'preview-read') {
      event({delta: {tool_calls: [{index: 0, id: 'preview-edit', type: 'function', function: {name: 'edit_file', arguments: JSON.stringify({path: 'hello.txt', oldText: '你好，Pi。', newText: '你好，Pi Web。'})}}]}, finish_reason: 'tool_calls'});
    } else {
      event({delta: {content: '已读取并修改 hello.txt。\n'}, finish_reason: null});
      event({delta: {content: '这是离线模拟模型对真实 Pi 文件工具的验证，没有调用外部模型。'}, finish_reason: 'stop'});
    }
    res.end('data: [DONE]\n\n');
  });
});
mock.listen(mockPort, '127.0.0.1', () => {
  const stateDir = path.join(root, '.test-tmp', fixture + '-state');
  const restoring = fs.existsSync(path.join(stateDir, 'config.json'));
  const childArgs = [path.join(root, 'dist/server.cjs'), '--port', String(webPort), '--state-dir', stateDir];
  const childEnv = Object.assign({}, process.env);
  delete childEnv.PI_API_KEY; delete childEnv.PI_BASE_URL; delete childEnv.PI_MODEL;
  if (!restoring) { childArgs.push('--workspace', workspace); childEnv.PI_BASE_URL = 'http://127.0.0.1:' + mockPort + '/v1'; childEnv.PI_MODEL = 'offline-ui-test'; }
  const child = spawn(process.execPath, childArgs, {
    stdio: 'inherit', windowsHide: true,
    env: childEnv
  });
  child.on('exit', () => mock.close());
  process.on('SIGINT', () => { child.kill(); mock.close(); });
  process.on('SIGTERM', () => { child.kill(); mock.close(); });
});
