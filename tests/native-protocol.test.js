'use strict';
// Child-process protocol fixture for prep/native.js (simulated helper only).
// Proves: fragmented ready/paused stderr lines reassemble, malformed frames
// terminate the child as a protocol failure (no ReferenceError, no linger),
// stop() tears down promptly with timers cleaned up. Never real capture.
const test=require('node:test'),assert=require('node:assert/strict');
const {startCapture}=require('../prep/native');

const FIXTURE=`
const READY=JSON.stringify({ok:true,ready:true,scope:'fixture-scope',withMic:false});
// Fragmented ready line across two stderr writes.
process.stderr.write(READY.slice(0,19));
setTimeout(()=>{process.stderr.write(READY.slice(19)+'\\n');},40);
let rest='';
process.stdin.on('data',d=>{
  rest+=d.toString();
  if(rest.includes('pause\\n')){
    rest='';
    const ack=JSON.stringify({ok:true,paused:true});
    process.stderr.write(ack.slice(0,12)); // split ack
    setTimeout(()=>process.stderr.write(ack.slice(12)+'\\n'),30);
  }
  if(rest.includes('stop\\n')){process.exit(0);}
});
// Malformed frame: unknown channel 7. Must trigger protocol failure.
setTimeout(()=>{
  const b=Buffer.alloc(9);b[0]=7;b.writeUInt32LE(4,1);
  process.stdout.write(b);
},250);
setTimeout(()=>{},8000);
`;

function startFixture(hooks={}){
  return startCapture({app:'zoom.us',withMic:false,...hooks},{
    binary:process.execPath,prefixArgs:['-e',FIXTURE,'--'],
  });
}

test('fragmented ready line still resolves ready with scope',async()=>{
  const h=startFixture();
  const info=await h.ready;
  assert.equal(info.scope,'fixture-scope');
  await h.stop();
});

test('split pause ack resolves; malformed frame kills child, no ReferenceError',async t=>{
  const errors=[];
  const h=startFixture({onError:e=>errors.push(e)});
  t.after(async()=>{await h.stop().catch(()=>{});});
  await h.ready;
  assert.equal(await h.pause(),true); // split ack reassembled
  // Malformed frame at ~250ms must terminate the child as protocol failure.
  await new Promise(r=>setTimeout(r,700));
  assert.ok(errors.length>=1);
  assert.match(errors[0].message,/protocol failure/);
  assert.ok(!/ReferenceError|failed is not defined/.test(errors[0].message+errors[0].stack));
  const code=await h.stop();
  await new Promise(r=>setTimeout(r,100));
  assert.equal(h.process.exitCode!==null||h.process.killed||code!==null,true);
  assert.equal(h.process.exitCode!==null||h.process.signalCode!==null,true);
});
