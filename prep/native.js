'use strict';
// Owner for the compiled Swift ScreenCaptureKit helper (AUDIO ONLY).
// Main process owns the helper with fixed argument validation and abort cleanup.
// No shell interpolation: spawn uses argv arrays only. The helper inherits a
// minimal environment (no credentials). Protocol violations terminate the
// child as a protocol failure instead of silently resyncing.
const {spawn,spawnSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const SRC=path.join(__dirname,'native','sckit-audio.swift');
function binPath(){
  // Packaged builds must not mutate the signed asar: resolve the binary
  // outside it (app.asar.unpacked / resourcesPath). Source checkout: prep/native.
  try{
    const {app}=require('electron');
    if(app&&app.isPackaged){
      const noAsar=SRC.replace(/app\.asar([/\\])/,'app.asar.unpacked$1');
      if(fs.existsSync(noAsar.replace(/\.swift$/,'')))return noAsar.replace(/\.swift$/,'');
      const res=path.join(process.resourcesPath,'app.asar.unpacked','prep','native','sckit-audio');
      if(fs.existsSync(res))return res;
    }
  }catch{}
  return path.join(__dirname,'native','sckit-audio');
}
const BIN=binPath();
function swiftAvailable(){try{const r=spawnSync('swiftc',['--version'],{encoding:'utf8',timeout:15000});return !r.error&&r.status===0;}catch{return false;}}
function buildIfNeeded(){
  // Compile before build/launch; production launch must not mutate a
  // read-only signed bundle, so skip rebuild when packaged.
  try{if(require('electron').app?.isPackaged)return {binary:BIN,rebuilt:false};}catch{}
  let rebuild=false;
  try{const bin=fs.statSync(BIN),src=fs.statSync(SRC);rebuild=src.mtimeMs>bin.mtimeMs;}catch{rebuild=true;}
  if(!rebuild)return {binary:BIN,rebuilt:false};
  const r=spawnSync('swiftc',[SRC,'-o',BIN,'-framework','ScreenCaptureKit','-framework','AVFoundation','-framework','AppKit','-O'],{encoding:'utf8',timeout:180000});
  if(r.error||r.status!==0)throw Error('Native audio helper compilation failed. Install Xcode command-line tools; no audio was captured. '+(r.stderr||r.error?.message||'').slice(0,500));
  fs.chmodSync(BIN,0o755);
  return {binary:BIN,rebuilt:true};
}
function selfTest(){
  buildIfNeeded();
  // No shell pipelines (exit status must be the helper's own).
  const r=spawnSync(BIN,['--self-test'],{encoding:'utf8',timeout:60000,env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME||''}});
  if(r.error)throw Error('Native self-test could not run: '+(r.error.message||'').slice(0,200));
  let report=null;try{report=JSON.parse((r.stderr||'').trim().split('\n').filter(Boolean).pop());}catch{}
  if(r.status!==0||!report||report.ok!==true)throw Error('Native converter self-test FAILED. No audio was captured. '+(JSON.stringify(report&&report.checks||[])).slice(0,600));
  return report;
}
function validateRunOptions({app='',withMic=false,allowSystem=false}={}){
  if(typeof app!=='string'||app.length>120)throw Error('Invalid meeting-app selection.');
  if(!/^[A-Za-z0-9 ._\-()]*$/.test(app))throw Error('Meeting-app selection contains unsupported characters.');
  if(typeof withMic!=='boolean')throw Error('Invalid microphone option.');
  if(typeof allowSystem!=='boolean')throw Error('Invalid system-audio option.');
  app=app.trim();
  // All-system capture is only allowed via an explicit named choice, never a
  // silent fallback: empty app requires allowSystem===true.
  if(!app&&!allowSystem)throw Error('Select a meeting app, or explicitly enable all-system audio capture with its scope notice.');
  return {app,withMic,allowSystem};
}
// Fixed argv only; never interpolates user text into a shell string.
function listApps(){
  buildIfNeeded();
  const r=spawnSync(BIN,['--list-apps'],{encoding:'utf8',timeout:20000,env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME||''}});
  if(r.error)throw Error('Native audio helper could not run: '+(r.error.message||'').slice(0,300));
  try{const data=JSON.parse(r.stdout);if(!data||!Array.isArray(data.apps))throw Error('bad');return data.apps.slice(0,200);}catch{throw Error(sanitizeLine(r.stderr)||'Application list unavailable. Grant Screen Recording permission and retry.');}
}
// Bounded, sanitized single-line error parser: caps lines/length, strips
// control characters so helper stderr can never flood or corrupt the UI.
function sanitizeLine(text){
  const lines=String(text||'').split('\n').map(s=>s.replace(/[\x00-\x1f\x7f]/g,'').trim()).filter(Boolean);
  return lines.slice(-3).join(' | ').slice(0,500);
}
function minimalEnv(){
  return {PATH:'/usr/bin:/bin',HOME:process.env.HOME||'',LANG:process.env.LANG||'en_US.UTF-8',TMPDIR:process.env.TMPDIR||''};
}
// startCapture returns a handle with awaitable ready/stop lifecycle promises.
// ready resolves only after the helper reports {"ready":true} (with scope);
// recording must be treated as true only after ready resolves.
function startCapture({app='',withMic=false,allowSystem=false,onFrame,onScope,onStderr,onError}={},testHooks={}){
  const opts=validateRunOptions({app,withMic,allowSystem});
  buildIfNeeded();
  // Narrow testing seam: tests may substitute a fixture binary (argv array,
  // still no shell). Production always uses the compiled helper.
  const binary=testHooks.binary||BIN;
  const child=spawn(binary,[...(testHooks.prefixArgs||[]),'--run','--app',opts.app,'--mic',opts.withMic?'1':'0','--allow-system',opts.allowSystem?'1':'0'],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:minimalEnv()});
  let acc=Buffer.alloc(0),dead=false,isReady=false;
  let killTimer=null;
  const clearKillTimer=()=>{if(killTimer){clearTimeout(killTimer);killTimer=null;}};
  let readyResolve,readyReject;
  const ready=new Promise((res,rej)=>{readyResolve=res;readyReject=rej;});
  // Prevent unhandled rejection when the caller only uses callbacks.
  ready.catch(()=>{});
  const protocolFail=(why)=>{
    if(dead)return;dead=true;clearKillTimer();
    try{child.stdin.destroy();}catch{}
    try{child.kill('SIGKILL');}catch{}
    const err=Error('Native audio protocol failure ('+why+'). Capture terminated; no further audio will be processed.');
    readyReject(err);
    try{onError&&onError(err);}catch{}
  };
  const kill=()=>{ // graceful: ask, then SIGTERM, then SIGKILL. Timers cleared on exit.
    if(dead)return;dead=true;clearKillTimer();
    try{child.stdin.write('stop\n');}catch{}
    killTimer=setTimeout(()=>{try{child.kill('SIGTERM');}catch{}killTimer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},1500);},800);
    if(killTimer.unref)killTimer.unref();
  };
  const stop=()=>{ // awaitable full teardown
    kill();
    return new Promise(res=>{
      if(dead&&exited)return res(exitCode);
      const onExit=c=>{clearTimeout(fallback);res(c);};
      const fallback=setTimeout(()=>{child.removeListener('exit',onExit);res(null);},4000);
      if(fallback.unref)fallback.unref();
      child.once('exit',onExit);
    });
  };
  let exited=false,exitCode=null;
  // Per-handle pause/resume acknowledgment waiters, fed by stderr JSON lines.
  const ackWaiters=[];
  const feedAcks=(cleanLine)=>{
    for(let i=ackWaiters.length-1;i>=0;i--){
      const w=ackWaiters[i];
      if((w.kind==='paused'&&/"paused":\s*true/.test(cleanLine))||(w.kind==='resumed'&&/"resumed":\s*true/.test(cleanLine))){
        clearTimeout(w.timer);ackWaiters.splice(i,1);w.res(true);
      }
    }
  };
  child.stdout.on('data',chunk=>{
    if(dead)return;
    acc=Buffer.concat([acc,chunk]);
    // Bounded: overflow is a protocol failure, not a silent tail-truncate.
    if(acc.length>2*1024*1024){protocolFail('frame overflow');acc=Buffer.alloc(0);return;}
    while(acc.length>=5){
      const channel=acc[0];const len=acc.readUInt32LE(1);
      if(![0,1].includes(channel)||len===0||len>512*1024){protocolFail('invalid frame header');acc=Buffer.alloc(0);return;}
      if(acc.length<5+len)return;
      const pcm=acc.subarray(5,5+len);acc=acc.subarray(5+len);
      try{onFrame&&onFrame(channel,Buffer.from(pcm));}catch{}
    }
  });
  let errLines=[],errRest='';
  child.stderr.on('data',d=>{
    // Bounded line buffering: chunks split mid-line, so carry the remainder.
    const text=errRest+d.toString();
    errRest='';
    const parts=text.split('\n');
    // The last segment may be a partial JSON line; hold it (bounded).
    errRest=parts.pop()||'';
    if(errRest.length>4096)errRest=errRest.slice(-4096);
    for(const raw of parts){
      const line=raw.replace(/[\x00-\x1f\x7f]/g,'').trim();
      if(!line)continue;
      errLines.push(line);if(errLines.length>20)errLines.shift(); // bounded
      let info=null;try{info=JSON.parse(line);}catch{}
      if(info&&info.ready===true&&!isReady){isReady=true;clearReadyTimer();try{onScope&&onScope(info);}catch{}readyResolve(info);continue;}
      if(info&&(info.paused===true||info.resumed===true)){feedAcks(line);try{onScope&&onScope(info);}catch{}continue;}
      if(info&&info.ok===false&&!isReady){clearReadyTimer();readyReject(Error(sanitizeLine(line)));continue;}
    }
    try{onStderr&&onStderr(sanitizeLine(text));}catch{}
  });
  let readyTimer=setTimeout(()=>{readyReject(Error('Native audio helper did not report ready in time. Capture terminated.'));kill();},20000);
  if(readyTimer.unref)readyTimer.unref();
  const clearReadyTimer=()=>{if(readyTimer){clearTimeout(readyTimer);readyTimer=null;}};
  const rejectWaiters=(err)=>{
    for(let i=ackWaiters.length-1;i>=0;i--){const w=ackWaiters[i];clearTimeout(w.timer);ackWaiters.splice(i,1);w.rej(err);}
  };
  child.on('spawn-error',e=>{ // handles spawn errors (e.g. missing binary)
    if(dead)return;dead=true;clearKillTimer();clearReadyTimer();
    readyReject(Error('Native audio helper could not start: '+(e.message||'').slice(0,200)));
  });
  child.on('error',e=>{
    if(dead)return;
    clearReadyTimer();
    readyReject(Error('Native audio helper process error: '+(e.message||'').slice(0,200)));
    kill(); // defensive: never leave the child running after a process error
  });
  child.on('exit',(code)=>{
    dead=true;exited=true;exitCode=code;clearKillTimer();clearReadyTimer(); // never reuse timers/PID
    rejectWaiters(Error('Capture ended before pausing/resuming was acknowledged.'));
    try{child.stdin.destroy();}catch{}
    try{child.stdout.destroy();}catch{}
    try{child.stderr.destroy();}catch{}
    if(!isReady)readyReject(Error(sanitizeLine(errLines.slice(-3).join(' | '))||'Native audio capture exited before becoming ready (code '+code+'). No audio was captured.'));
  });
  const waitAck=(kind,timeoutMs)=>new Promise((res,rej)=>{
    if(dead)return rej(Error('Capture is not running.'));
    const timer=setTimeout(()=>{const i=ackWaiters.findIndex(w=>w.timer===timer);if(i!==-1)ackWaiters.splice(i,1);rej(Error(kind==='paused'?'Pause was not acknowledged.':'Resume was not acknowledged.'));},timeoutMs);
    if(timer.unref)timer.unref();
    ackWaiters.push({kind,timer,res,rej});
  });
  return {
    process:child,ready,kill,stop,
    pause(){try{child.stdin.write('pause\n');}catch(e){return Promise.reject(e);}return waitAck('paused',5000);},
    resume(){try{child.stdin.write('resume\n');}catch(e){return Promise.reject(e);}return waitAck('resumed',8000);},
    errors:()=>sanitizeLine(errLines.slice(-3).join(' | ')),
  };
}
module.exports={buildIfNeeded,listApps,startCapture,validateRunOptions,swiftAvailable,selfTest,sanitizeLine,BIN,SRC};
