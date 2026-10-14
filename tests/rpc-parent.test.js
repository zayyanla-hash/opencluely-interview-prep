'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {WorkerRPC}=require('../auth/rpc-parent');

test('worker stdio RPC streams responses and isolates privileged operations',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'siwc-worker-fixture-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const script=path.join(dir,'stub.cjs');
 fs.writeFileSync(script,`const readline=require('node:readline');
function send(m){process.stdout.write(JSON.stringify(m)+'\\n')}
let original;
readline.createInterface({input:process.stdin}).on('line',l=>{
  const x=JSON.parse(l);
  if(x.kind==='parent-response'){send({kind:'result',id:original,ok:x.ok,result:x.result});return;}
  if(x.method==='probe'){original=x.id;send({kind:'parent-request',id:11,method:'encryption-available',payload:{}});return;}
  if(x.method==='run'){send({kind:'stream',id:x.id,delta:'Hello '});send({kind:'stream',id:x.id,delta:'GPT'});send({kind:'result',id:x.id,ok:true,result:'Hello GPT'});return;}
});`);
 const worker=new WorkerRPC({binary:process.execPath,script,onParentRequest:async method=>{assert.equal(method,'encryption-available');return true;}});
 t.after(()=>worker.close());
 assert.equal(await worker.call('probe'),true);
 let output='';
 assert.equal(await worker.call('run',{input:'Hello'},s=>output+=s),'Hello GPT');
 assert.equal(output,'Hello GPT');
});
