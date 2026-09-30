'use strict';
const path=require('path');
const spawnSync=require('child_process').spawnSync;
const root=path.resolve(__dirname,'..');
const tests=['session-groups','session-stats','python-runtime','python-integration','local-tools','folder-browser','context','compaction','permissions','mcp-skills','pi-resources','pi-session','dsh-prompts','provider-retry','persistence','integration','features','persistence-integration','long-conversation'];
for(const name of tests){
  const result=spawnSync(process.execPath,[path.join(root,'tests',name+'.test.js')],{cwd:root,stdio:'inherit',shell:false,windowsHide:true});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status||1);
}
console.log('All '+tests.length+' suites passed on '+process.version+'.');
