'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=path.resolve(__dirname,'..');
const arch=process.argv.includes('--x86')?'x86':'x64';
if(arch!=='x64')throw new Error('The bundled Python release currently supports x64 only.');
const runtime=path.join(root,'.runtime',arch);
const manifest=JSON.parse(fs.readFileSync(path.join(runtime,'runtime.json'),'utf8'));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if(hash(path.join(runtime,'node.exe'))!==manifest.sha256)throw new Error('Node runtime checksum mismatch');
const python=path.join(root,'.runtime','python38-x64');
const pythonManifest=JSON.parse(fs.readFileSync(path.join(python,'runtime-manifest.json'),'utf8'));
const pythonLock=fs.readFileSync(path.join(root,'scripts','python-runtime-lock.json'));
if(pythonManifest.schemaVersion!==1||pythonManifest.runtimeId!=='python38-x64'||pythonManifest.python.version!=='3.8.10'||pythonManifest.python.architecture!=='x64')throw new Error('Unexpected Python runtime');
if(pythonManifest.lockSha256!==crypto.createHash('sha256').update(pythonLock).digest('hex'))throw new Error('Python runtime does not match the checked-in dependency lock');
if(!pythonManifest.validation||pythonManifest.validation.developer.status!=='passed')throw new Error('Python developer import probe must pass before packaging');
function filesUnder(directory,prefix=''){
 const files=[];
 for(const item of fs.readdirSync(directory,{withFileTypes:true})){
  const relative=prefix+item.name;
  if(item.isSymbolicLink())throw new Error('Symlinks are not portable: '+relative);
  if(item.isDirectory())files.push(...filesUnder(path.join(directory,item.name),relative+'/'));
  else if(item.isFile())files.push(relative);
  else throw new Error('Unsupported runtime entry: '+relative);
 }
 return files;
}
const entries=pythonManifest.files;
if(!Array.isArray(entries)||!entries.length)throw new Error('Missing Python runtime inventory');
const expected=new Set(['runtime-manifest.json']);
for(const entry of entries){
 if(typeof entry.path!=='string'||entry.path.includes('\\')||entry.path.split('/').some(part=>!part||part==='.'||part==='..'||part.includes(':'))||expected.has(entry.path))throw new Error('Invalid runtime inventory path');
 expected.add(entry.path);
 const full=path.join(python,entry.path);
 if(!Number.isSafeInteger(entry.size)||fs.statSync(full).size!==entry.size||hash(full)!==entry.sha256)throw new Error('Python runtime checksum mismatch: '+entry.path);
}
const actual=filesUnder(python);
if(actual.length!==expected.size||actual.some(file=>!expected.has(file)))throw new Error('Python runtime contains untracked or missing files; rebuild it before packaging');
if(actual.some(file=>/(^|\/)(__pycache__|pip|pip-[^/]*\.dist-info)(\/|$)|\.py[co]$/i.test(file)))throw new Error('Build-only pip or bytecode caches must not be shipped');
for(const file of ['python.exe','runtime-probe.py','THIRD_PARTY_NOTICES.txt','pe-imports.json'])if(!expected.has(file))throw new Error('Python runtime file missing: '+file);
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
if(JSON.parse(fs.readFileSync(path.join(root,'dist/build-meta.json'),'utf8')).appVersion!==version)throw new Error('Rebuild the application after changing its version');
const output=path.join(root,'release','pi-win7-web-'+version+'-'+arch);
if(fs.existsSync(output)&&fs.readdirSync(output).length)throw new Error('Release directory is not empty. Use a new version or move the reviewed old output before packaging: '+output);
function copyTree(src,dst){
 fs.mkdirSync(dst,{recursive:true});
 for(const item of fs.readdirSync(src,{withFileTypes:true})){
  if(item.isSymbolicLink())throw new Error('Cannot package symbolic link: '+item.name);
  if(item.isDirectory())copyTree(path.join(src,item.name),path.join(dst,item.name));
  else if(item.isFile())fs.copyFileSync(path.join(src,item.name),path.join(dst,item.name));
 }
}
fs.mkdirSync(path.join(output,'dist'),{recursive:true});
for(const name of ['server.cjs','server.cjs.map','build-meta.json','THIRD_PARTY_NOTICES.txt'])fs.copyFileSync(path.join(root,'dist',name),path.join(output,'dist',name));
copyTree(path.join(root,'dist','public'),path.join(output,'dist','public'));
copyTree(runtime,path.join(output,'runtime'));
copyTree(python,path.join(output,'runtime','python38-x64'));
copyTree(path.join(root,'builtin-skills'),path.join(output,'builtin-skills'));
for(const name of ['launch.vbs','README.md','VALIDATION.md','PI-MIGRATION.md','LICENSE'])fs.copyFileSync(path.join(root,name),path.join(output,name));
fs.mkdirSync(path.join(output,'workspace'),{recursive:true});
copyTree(path.join(root,'examples'),path.join(output,'examples'));
copyTree(path.join(root,'examples','skills'),path.join(output,'workspace','.agents','skills'));
copyTree(path.join(root,'examples','prompts'),path.join(output,'workspace','.pi','prompts'));
console.log(output);
