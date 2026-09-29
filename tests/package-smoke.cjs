'use strict';
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert'),spawn=require('child_process').spawn;
const packageRoot=path.resolve(process.argv[2]);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(packageRoot,'dist/build-meta.json'),'utf8')).appVersion,'0.5.0');
for(const name of ['.state','node_modules','.npm-cache'])assert(!fs.existsSync(path.join(packageRoot,name)),'Private/development content in archive: '+name);
const notices=fs.readFileSync(path.join(packageRoot,'dist/THIRD_PARTY_NOTICES.txt'),'utf8');assert(notices.includes('Pi coding-agent'));assert(notices.includes('DeepSeek'));assert(notices.includes('MIT License'));
assert(fs.existsSync(path.join(packageRoot,'dist/public/session-groups.js')));
assert(fs.readFileSync(path.join(packageRoot,'dist/public/index.html'),'utf8').includes('session-groups.js'));
let port=0,token='',output='';
const privateState=fs.mkdtempSync(path.join(path.resolve(__dirname,'../.test-tmp'),'package-state-'));
const server=spawn(path.join(packageRoot,'runtime/node.exe'),[path.join(packageRoot,'dist/server.cjs'),'--workspace',path.join(packageRoot,'workspace'),'--port','0','--state-dir',privateState],{cwd:packageRoot,stdio:['ignore','pipe','pipe'],windowsHide:true,shell:false});
function request(method,url,body){return new Promise((ok,no)=>{const data=body===undefined?undefined:JSON.stringify(body);const headers={'X-Agent-Token':token};if(data){headers['Content-Type']='application/json';headers['Content-Length']=Buffer.byteLength(data);}const req=http.request({hostname:'127.0.0.1',port,method,path:url,headers},res=>{let b='';res.setEncoding('utf8');res.on('data',c=>b+=c);res.on('end',()=>{try{ok({status:res.statusCode,json:JSON.parse(b)});}catch(e){no(e);}});});req.on('error',no);req.setTimeout(10000,()=>req.destroy(new Error('Package API timeout')));req.end(data);});}
(async()=>{
 await new Promise((ok,no)=>{const t=setTimeout(()=>no(Error('Package startup failed: '+output)),10000);server.on('error',no);server.stdout.on('data',c=>{output+=c;const m=/http:\/\/127\.0\.0\.1:(\d+)/.exec(output);if(m){port=Number(m[1]);clearTimeout(t);ok();}});server.stderr.on('data',c=>output+=c);});
 const boot=(await request('GET','/api/bootstrap')).json;token=boot.csrfToken;assert.strictEqual(boot.permissionMode,'workspace-write');assert(boot.compaction.enabled);
 const extensions=(await request('GET','/api/extensions')).json;assert(extensions.skills.some(s=>s.name==='win7-smoke-test'));
 const example=extensions.exampleMcpConfig;assert(example.mcpServers.demo.command.startsWith(packageRoot));assert(example.mcpServers.demo.args[0].startsWith(packageRoot));
 assert.strictEqual((await request('POST','/api/extensions',{mcpServers:example})).status,200);
 const check=await request('POST','/api/mcp/test',{id:'demo'});assert(check.json.connected,JSON.stringify(check));assert.deepStrictEqual(check.json.tools.map(t=>t.name),['echo','add']);
 const resources=(await request('GET','/api/pi/resources')).json;assert(resources.prompts.some(p=>p.name==='win7-review'));assert(resources.builtinPresets.some(p=>p.value==='standard'&&p.available));
 assert(output.includes('v12.22.12'));
 console.log('PASS extracted 0.5.0 ZIP: actual Node12 startup, clean archive, DSH presets, packaged Skill/template discovery and portable MCP demo handshake.');
})().catch(e=>{console.error(e);process.exitCode=1;}).then(()=>{server.kill();});
