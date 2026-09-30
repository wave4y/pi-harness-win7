'use strict';
// Real Pi loop + bundled CPython. The model endpoint is a deterministic local fixture.
const assert=require('assert'),fs=require('fs'),path=require('path'),http=require('http'),cp=require('child_process');
const root=path.resolve(__dirname,'..'),temp=path.join(root,'.test-tmp');fs.mkdirSync(temp,{recursive:true});
const fixture=fs.mkdtempSync(path.join(temp,'python-integration-'));
const workspace=path.join(fixture,'中文 工作区'),second=path.join(fixture,'另一个项目'),stateDir=path.join(fixture,'state');
for(const dir of [workspace,second,stateDir])fs.mkdirSync(dir);
const runtime=path.join(root,'.runtime/python38-x64');
assert(fs.existsSync(path.join(runtime,'python.exe')),'Build the pinned Python runtime with npm run fetch:python before integration testing.');
const script=path.join(workspace,'参数 测试.py'),marker=path.join(workspace,'result.json');
fs.writeFileSync(script,'import json,os,sys\nfrom pathlib import Path\nresult={"args":sys.argv[1:],"cwd":os.getcwd(),"secret":os.environ.get("EXAMPLE_API_KEY"),"version":list(sys.version_info[:3])}\nPath("result.json").write_text(json.dumps(result,ensure_ascii=False),encoding="utf-8")\nprint(json.dumps(result,ensure_ascii=False))\n');
const literal=['中文 参数','& | > $(echo ignored)','--flag'];
let port=0,token='',server,output='',mockFailure,started=false;
const sockets=new Set();
function request(method,url,body,noToken){return new Promise((resolve,reject)=>{
 const data=body===undefined?undefined:JSON.stringify(body),headers=noToken?{}:{'X-Agent-Token':token};
 if(data){headers['Content-Type']='application/json';headers['Content-Length']=Buffer.byteLength(data);}
 const req=http.request({hostname:'127.0.0.1',port,path:url,method,headers},res=>{let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>{try{resolve({status:res.statusCode,json:JSON.parse(text),text});}catch(e){reject(e);}});res.on('error',reject);});
 req.on('error',reject);req.setTimeout(45000,()=>req.destroy(Error('API timeout: '+url)));req.end(data);
});}
function chat(message,onApproval){return new Promise((resolve,reject)=>{
 const events=[],approvals=[];let pending='',failure;
 const data=JSON.stringify({message});
 const req=http.request({hostname:'127.0.0.1',port,path:'/api/chat',method:'POST',headers:{'X-Agent-Token':token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},res=>{
 res.setEncoding('utf8');res.on('data',chunk=>{pending+=chunk;let n;while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n).trim();pending=pending.slice(n+1);if(!line.startsWith('data: '))continue;try{const event=JSON.parse(line.slice(6));events.push(event);if(event.type==='approval_request')approvals.push(Promise.resolve().then(()=>{assert(onApproval,'Unexpected approval');return onApproval(event);}).catch(e=>{failure=e;req.destroy(e);}));}catch(e){failure=e;req.destroy(e);}}});
 res.on('error',reject);res.on('end',async()=>{await Promise.all(approvals);if(failure||mockFailure)return reject(failure||mockFailure);try{assert.strictEqual(res.statusCode,200);assert(events.some(e=>e.type==='done'),JSON.stringify(events));resolve(events);}catch(e){reject(e);}});
 });req.on('error',reject);req.setTimeout(60000,()=>req.destroy(Error('Python chat timeout')));req.end(data);
});}
function chunk(delta,finish){return 'data: '+JSON.stringify({choices:[{index:0,delta:delta||{},finish_reason:finish||null}]})+'\n\n';}
function tool(res,name,args,id){res.end(chunk({tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]})+chunk({},'tool_calls')+'data: [DONE]\n\n');}
const provider=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{try{
 const body=JSON.parse(raw),latest=body.messages.map(m=>m.role).lastIndexOf('user'),prompt=body.messages[latest].content,results=body.messages.slice(latest+1).filter(m=>m.role==='tool');
 assert(body.tools.some(t=>t.function.name==='run_python'));
 assert(body.messages[0].content.includes('portable-python'));
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 if(prompt==='SELF_TEST'){
  if(!results.length)return tool(res,'read_skill',{skill:'portable-python'},'load-python-skill');
  assert(results[0].content.includes('self_test.py'));
  if(results.length===1){
   const location=/Skill resource location: (\{[^\n]+\})/.exec(results[0].content);assert(location,'Model needs the actual skill location to run its support scripts');
   const directory=JSON.parse(location[1]).skillDirectory;assert.strictEqual(directory,path.join(root,'builtin-skills','portable-python'));
   return tool(res,'run_python',{script:path.join(directory,'scripts/self_test.py'),args:['--output-dir',second],timeoutMs:120000},'python-self-test');
  }
 }else if(!results.length)return tool(res,'run_python',{script,args:literal,cwd:workspace},'python-args');
 res.end(chunk({content:'Python 测试回合完成。'})+chunk({},'stop')+'data: [DONE]\n\n');
 }catch(e){mockFailure=e;if(!res.headersSent)res.writeHead(500);res.end();}});});
provider.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
async function start(){port=0;output='';await new Promise((resolve,reject)=>{
 const childArgs=[path.join(root,'dist/server.cjs'),'--state-dir',stateDir,'--port','0'];if(!started)childArgs.push('--workspace',workspace);started=true;
 server=cp.spawn(process.execPath,childArgs,{cwd:root,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:Object.assign({},process.env,{PI_API_KEY:'',PI_MODEL:'',PI_BASE_URL:'',PORT:'',EXAMPLE_API_KEY:'must-not-inherit'})});
 const timer=setTimeout(()=>reject(Error('Startup: '+output)),10000);
 server.on('error',e=>{clearTimeout(timer);reject(e);});server.on('exit',code=>{if(!port){clearTimeout(timer);reject(Error('Exited '+code+': '+output));}});
 server.stdout.on('data',c=>{output+=c;const m=/http:\/\/127\.0\.0\.1:(\d+)/.exec(output);if(m){port=Number(m[1]);clearTimeout(timer);resolve();}});server.stderr.on('data',c=>output+=c);
 });token=(await request('GET','/api/bootstrap',undefined,true)).json.csrfToken;}
async function stop(){if(server&&server.exitCode===null)await new Promise(resolve=>{server.once('exit',resolve);server.kill();});}
async function mode(value){assert.strictEqual((await request('POST','/api/permissions',{mode:value})).status,200);}
function result(events,name){const found=events.find(e=>e.type==='tool_end'&&e.name===name);assert(found,JSON.stringify(events));return found;}
(async()=>{
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));await start();
 assert.strictEqual((await request('GET','/api/python',undefined,true)).status,403);
 let status=(await request('GET','/api/python')).json;assert(status.available);assert(!status.ready);assert.strictEqual(status.state,'not-tested');
 assert.strictEqual((await request('POST','/api/python/probe',{script:'arbitrary.py'})).status,400);
 const ext=(await request('GET','/api/extensions')).json;assert(ext.skills.some(s=>s.name==='portable-python'&&s.source==='builtin'));
 assert.strictEqual((await request('POST','/api/settings',{workspace,model:'python-test',baseUrl:'http://127.0.0.1:'+provider.address().port+'/v1',contextWindow:100000})).status,200);
 // Reject before the child process can write anything.
 let events=await chat('DENY',async approval=>{assert.strictEqual(approval.toolName,'run_python');assert.strictEqual(approval.args.executable,path.join(runtime,'python.exe'));assert.strictEqual(approval.args.script,script);assert.strictEqual(approval.args.cwd,workspace);assert.deepStrictEqual(approval.args.args.slice(0,3),['-I','-X','utf8']);assert(!fs.existsSync(marker));assert.strictEqual((await request('POST','/api/approval',{id:approval.id,decision:'deny'})).status,200);});
 assert(result(events,'run_python').isError);assert(!fs.existsSync(marker));
 for(const permission of ['workspace-write','read-only']){
  await mode(permission);events=await chat('ALLOW '+permission,async approval=>{assert.strictEqual(approval.toolName,'run_python');assert.strictEqual((await request('POST','/api/approval',{id:approval.id,decision:'allow'})).status,200);});
  assert(!result(events,'run_python').isError,JSON.stringify(result(events,'run_python')));
  const actual=JSON.parse(fs.readFileSync(marker,'utf8'));assert.deepStrictEqual(actual.args,literal);assert.strictEqual(actual.secret,null);assert.deepStrictEqual(actual.version,[3,8,10]);assert.strictEqual(actual.cwd,workspace);
 }
 status=(await request('GET','/api/python')).json;assert(status.ready);assert.strictEqual(status.probe.modules.length,20);assert.strictEqual(status.win7Validated,false);
 await mode('danger-full-access');events=await chat('FULL');assert(!events.some(e=>e.type==='approval_request'));assert(!result(events,'run_python').isError);
 assert.strictEqual((await request('POST','/api/workspace',{workspace:second})).status,200);
 const moved=(await request('GET','/api/extensions')).json;assert(moved.skills.some(s=>s.name==='portable-python'&&s.source==='builtin'));
 await mode('danger-full-access');events=await chat('SELF_TEST');assert(!result(events,'read_skill').isError);assert(!result(events,'run_python').isError,JSON.stringify(result(events,'run_python')));assert(fs.readdirSync(second).length>0);
 const before=(await request('GET','/api/session')).json;
 await stop();await start();assert((await request('GET','/api/extensions')).json.skills.some(s=>s.name==='portable-python'));
 const history=(await request('GET','/api/session')).json;assert(history.events.some(m=>m.type==='tool_end'&&m.name==='run_python'));assert.strictEqual(history.messages.length,before.messages.length);
 const probe=(await request('POST','/api/python/probe',{})).json;assert(probe.ready,JSON.stringify(probe));
 console.log('PASS Python integration: real Pi + CPython3.8, authenticated fixed probe, deny/approve/full access, literal Chinese args, clean env, built-in Skill after folder switch, real document roundtrip, persisted results after restart.');
})().catch(e=>{console.error(e);process.exitCode=1;}).then(async()=>{await stop();for(const socket of sockets)socket.destroy();provider.close();});
