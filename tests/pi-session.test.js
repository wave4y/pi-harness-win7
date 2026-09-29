'use strict';
const assert=require('assert');
const crypto=require('crypto');
const {exportPiJsonl,exportSessionHtml,forkPiMessages,piSessionTree,buildPiSessionContext}=require('../dist/session.cjs');
const user={role:'user',content:'请查看文件',timestamp:1};
const call={role:'assistant',content:[{type:'toolCall',id:'c1',name:'read_file',arguments:{path:'hello.txt'}}],stopReason:'toolUse',timestamp:2};
const result={role:'toolResult',toolCallId:'c1',toolName:'read_file',content:[{type:'text',text:'<script>alert(1)</script>'}],isError:false,timestamp:3};
const answer={role:'assistant',content:[{type:'text',text:'文件已读'}],stopReason:'stop',timestamp:4};
const record={workspace:process.cwd(),sessionId:'a'.repeat(24),name:'测试 <script>',model:'test',messages:[user,call,result,answer]};
const entries=exportPiJsonl(record).trim().split('\n').map(JSON.parse);
assert.strictEqual(entries[0].type,'session');assert.strictEqual(entries[0].version,3);
const ids=new Set();for(const entry of entries.slice(1)){assert(!ids.has(entry.id));if(entry.parentId)assert(ids.has(entry.parentId));ids.add(entry.id);}
assert.deepStrictEqual(entries.filter(x=>x.type==='message').map(x=>x.message),record.messages);
assert.deepStrictEqual(forkPiMessages(record),record.messages);
assert.deepStrictEqual(forkPiMessages(record,0),[user]);assert.throws(()=>forkPiMessages(record,1),/工具/);
assert.deepStrictEqual(forkPiMessages(record,2),[user,call,result]);assert.throws(()=>forkPiMessages(record,99));
const html=exportSessionHtml(record);assert(html.includes('&lt;script&gt;'));assert(!html.includes('<script>'));assert(html.includes('Content-Security-Policy'));
const tree=piSessionTree(record);assert.strictEqual(tree.length,4);assert.strictEqual(tree[1].canFork,false);assert.strictEqual(tree[3].canFork,true);
assert.strictEqual(record.messages.length,4);

function checkpoint(messages,count) {
  const hash=crypto.createHash('sha256');
  for(let index=0;index<count;index++)hash.update(JSON.stringify(messages[index])+'\n');
  return {version:1,summary:'CHECKPOINT: preserve the original goal.',summarizedMessageCount:count,prefixHash:hash.digest('hex'),tokensBefore:12345,readFiles:['hello.txt'],modifiedFiles:['output.txt']};
}
function imported(messages,count,retained) {
  const exported=exportPiJsonl({...record,messages,compactionState:checkpoint(messages,count)}).trim().split('\n').map(JSON.parse);
  const entries=exported.filter(entry=>entry.type!=='session');
  const originals=entries.filter(entry=>entry.type==='message').slice(0,messages.length);
  assert.deepStrictEqual(originals.map(entry=>entry.message),messages,'Export deleted or changed original history');
  const known=new Set();
  for(const entry of entries){if(entry.parentId)assert(known.has(entry.parentId),'Export has an orphaned branch');known.add(entry.id);}
  const compaction=entries[entries.length-1];
  assert.strictEqual(compaction.type,'compaction');
  assert(known.has(compaction.firstKeptEntryId));
  assert.deepStrictEqual(compaction.details.modifiedFiles,['output.txt']);
  const context=buildPiSessionContext(entries);
  assert.strictEqual(context.messages[0].role,'compactionSummary');
  assert.strictEqual(context.messages[0].summary,'CHECKPOINT: preserve the original goal.');
  assert.deepStrictEqual(context.messages.slice(1),retained);
  return {entries,originals};
}
// All original messages can be summarized: the exact latest request remains active.
imported(record.messages,record.messages.length,[user]);
const secondCall={...call,content:[{...call.content[0],id:'c2'}]};
const secondResult={...result,toolCallId:'c2'};
const splitHistory=[user,call,result,secondCall,secondResult,answer];
const splitExport=imported(splitHistory,3,[user,secondCall,secondResult,answer]);
// The old suffix branch is still available, separately from the compacted active branch.
assert.deepStrictEqual(buildPiSessionContext(splitExport.entries,splitExport.originals[5].id).messages,splitHistory);
const nextUser={role:'user',content:'The next task must remain exact',timestamp:5};
imported(record.messages.concat([nextUser,answer]),4,[nextUser,answer]);
const aborted={...call,stopReason:'aborted',content:[{...call.content[0],id:'incomplete'}]};
imported([user,call,result,aborted],3,[user]);
// A stale checkpoint must not override a changed history in the exported session.
const stale={...record,compactionState:{...checkpoint(record.messages,3),prefixHash:'0'.repeat(64)}};
const staleEntries=exportPiJsonl(stale).trim().split('\n').map(JSON.parse).filter(entry=>entry.type!=='session');
assert(!staleEntries.some(entry=>entry.type==='compaction'));
assert.deepStrictEqual(buildPiSessionContext(staleEntries).messages,record.messages);

// A cancelled/failed streamed tool-call fragment is never executable and may be forked.
for (const stopReason of ['aborted','error']) {
  const stopped={...call,stopReason,errorMessage:'Request stopped'};
  const stoppedRecord={...record,messages:[user,stopped]};
  assert.deepStrictEqual(forkPiMessages(stoppedRecord),stoppedRecord.messages);
  assert.strictEqual(piSessionTree(stoppedRecord)[1].canFork,true);
  const prepared=require('../dist/context.cjs').prepareContext(forkPiMessages(stoppedRecord),'',[],{contextWindow:8192,maxOutputTokens:512},{allowTruncation:false});
  assert.deepStrictEqual(prepared.messages,[user]);
}
assert.throws(()=>forkPiMessages({...record,messages:[user,call]}),/工具/);
assert.strictEqual(piSessionTree({...record,messages:[user,call]})[1].canFork,false);

console.log('PASS vendored Pi SessionManager on '+process.version+': v3 JSONL, parent tree, fork context, tool pairing and escaped HTML export.');
