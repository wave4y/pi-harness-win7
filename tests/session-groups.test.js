'use strict';
const assert = require('assert');
const groups = require('../public/session-groups');
let passed = 0;
function test(name, run) { run(); passed++; console.log('ok ' + name); }
const workspace = groups.workspaceInfo;

test('Windows folder spellings share one identity, with directory boundaries preserved', () => {
  const variants = ['D:\\Work\\Agent', 'd:/work/agent/', 'D:\\Work\\.\\Agent\\', 'd:/work/other/../agent', '\\\\?\\D:\\WORK\\Agent'];
  variants.forEach(value => assert.strictEqual(workspace(value).key, 'win:d:/work/agent'));
  assert.notStrictEqual(workspace('D:\\Work\\Agent').key, workspace('D:\\Other\\Agent').key);
  assert.notStrictEqual(workspace('D:\\Work\\Agent').key, workspace('D:\\Work\\Agent2').key);
  assert.notStrictEqual(workspace('D:\\Work\\Agent').key, workspace('E:\\Work\\Agent').key);
  assert.strictEqual(workspace('C:\\').name, 'C:\\');
  assert.strictEqual(workspace('C:/../../').key, 'win:c:/');
});

test('UNC shares normalize case, separators, extended paths and bounded parent traversal', () => {
  const variants = ['\\\\Server\\Share\\Folder', '//server/share/folder/', '//SERVER//Share//Folder', '\\\\?\\UNC\\SERVER\\Share\\Folder'];
  variants.forEach(value => assert.strictEqual(workspace(value).key, 'win://server/share/folder'));
  assert.strictEqual(workspace('\\\\Server\\Share\\..\\..\\Folder').key, 'win://server/share/folder');
  assert.notStrictEqual(workspace('//server/one/Folder').key, workspace('//server/two/Folder').key);
  assert.strictEqual(workspace('//server/share/').path, '\\\\server\\share');
});

test('POSIX case-sensitive folders and missing legacy paths remain separate', () => {
  assert.notStrictEqual(workspace('/work/Agent').key, workspace('/work/agent').key);
  assert.strictEqual(workspace('/work/../Agent/').path, '/Agent');
  assert.strictEqual(workspace('/').name, '/');
  assert.strictEqual(workspace(undefined).key, workspace('').key);
  assert.notStrictEqual(workspace('').key, workspace('未指定文件夹').key);
});

const sessions = [
  {id: 'old', title: '修复编码', workspace: 'D:\\Work\\Agent', model: 'deepseek-chat', updatedAt: 100},
  {id: 'new', title: '保存设置', workspace: 'd:/work/agent/', model: 'deepseek-reasoner', updatedAt: 300, active: true},
  {id: 'same-name', title: '其他项目', workspace: 'D:\\Other\\Agent', model: 'deepseek-chat', updatedAt: 200},
  {id: 'unc', title: '服务器任务', workspace: '\\\\Server\\Share', updatedAt: 150},
];

test('full path grouping orders folders and their sessions by newest activity without mutating history', () => {
  const before = JSON.stringify(sessions);
  const result = groups.groupSessions(sessions);
  assert.deepStrictEqual(result.map(group => group.key), ['win:d:/work/agent', 'win:d:/other/agent', 'win://server/share']);
  assert.deepStrictEqual(result[0].sessions.map(session => session.id), ['new', 'old']);
  assert.strictEqual(result[0].totalCount, 2);
  assert.strictEqual(result[0].active, true);
  assert.strictEqual(result[1].active, false);
  assert.strictEqual(result[0].name.toLowerCase(), result[1].name.toLowerCase());
  assert.strictEqual(JSON.stringify(sessions), before);
});

test('search returns matching sessions, or the entire matching folder, preserving full counts', () => {
  const title = groups.groupSessions(sessions, '修复');
  assert.deepStrictEqual(title[0].sessions.map(session => session.id), ['old']);
  assert.strictEqual(title[0].totalCount, 2);
  assert.strictEqual(title[0].updatedAt, 300);
  const folder = groups.groupSessions(sessions, 'D:\\WORK\\AGENT');
  assert.strictEqual(folder.length, 1);
  assert.deepStrictEqual(folder[0].sessions.map(session => session.id), ['new', 'old']);
  assert.strictEqual(groups.groupSessions(sessions, 'reasoner')[0].sessions[0].id, 'new');
  assert.deepStrictEqual(groups.groupSessions(sessions, '不存在的项目'), []);
});

test('invalid dates sort last, ISO dates work, and equal timestamps have stable ordering', () => {
  const history = [
    {id: 'b', workspace: 'C:/same', updatedAt: 100},
    {id: 'z', workspace: 'C:/same', updatedAt: 'invalid'},
    {id: 'a', workspace: 'C:/same', updatedAt: 100},
    {id: 'first', workspace: 'C:/same', updatedAt: '2026-01-01T00:00:00Z'},
  ];
  assert.deepStrictEqual(groups.groupSessions(history)[0].sessions.map(session => session.id), ['first', 'a', 'b', 'z']);
  assert.deepStrictEqual(groups.groupSessions(null), []);
});

test('saved collapse wins over active-group default; search expansion does not change preferences', () => {
  const group = groups.groupSessions(sessions)[0];
  assert.strictEqual(groups.isExpanded(group, '', {}), true);
  assert.strictEqual(groups.isExpanded({key: 'win:x', active: false}, '', {}), false);
  const saved = {}; saved[group.key] = false;
  assert.strictEqual(groups.isExpanded(group, '', saved), false);
  assert.strictEqual(groups.isExpanded(group, '修复', saved), true);
  const temporary = {}; temporary[group.key] = false;
  assert.strictEqual(groups.isExpanded(group, '修复', saved, temporary), false);
  assert.strictEqual(groups.isExpanded(group, '', saved, temporary), false);
  assert.strictEqual(saved[group.key], false);
});

test('damaged or foreign browser preferences cannot corrupt group expansion', () => {
  [null, '', '{broken', 'null', '[]', 'false'].forEach(raw => assert.deepStrictEqual(Object.keys(groups.parseExpansion(raw)), []));
  const parsed = groups.parseExpansion('{"win:d:/work":false,"path:/project":true,"missing:":true,"win:e:/bad":"true","__proto__":{"polluted":true}}');
  assert.strictEqual(Object.getPrototypeOf(parsed), null);
  assert.deepStrictEqual(Object.keys(parsed).sort(), ['missing:', 'path:/project', 'win:d:/work']);
  assert.strictEqual(parsed['win:d:/work'], false);
  assert.strictEqual({}.polluted, undefined);
});

test('the same helper loads as a browser classic script before app.js', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const sandbox = {self: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/session-groups.js'), 'utf8'), sandbox);
  const browserHelper = sandbox.self.PiSessionGroups;
  assert.strictEqual(typeof browserHelper.groupSessions, 'function');
  assert.strictEqual(browserHelper.groupSessions(sessions)[0].sessions[0].id, 'new');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert(html.indexOf('<script src="/session-groups.js" defer>') >= 0);
  assert(html.indexOf('<script src="/session-groups.js" defer>') < html.indexOf('<script src="/app.js" defer>'));
});

console.log('Session grouping: ' + passed + ' tests passed.');
