'use strict';
// Live interview session orchestrator (main process).
// Meeting audio (interviewer) -> auto-answer. Microphone -> context only.
// Epoch-guarded lifecycle: pause/stop increment the session epoch so delayed
// transcription or a cancellation-ignoring backend can never emit after the
// session moved on. Single active generation; serialized transcription.
const {EventEmitter}=require('node:events'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {isQuestionCandidate,isDuplicate,createAccumulator,normalize}=require('./detect');
const {configuration}=require('./media');

const MAX_QUEUE=8; // total pending transcriptions (serialized, one at a time)
const MAX_RETAINED_QUESTIONS=10;
const RECENT_TTL_MS=5*60*1000;
const MAX_TMP_WAVS=20;
const MAX_STDOUT_BUF=64*1024;

function rmsEnergy(buf){
  const n=Math.floor(buf.length/2);if(!n)return 0;
  let s=0;for(let i=0;i<n;i++){const v=buf.readInt16LE(i*2)/32768;s+=v*v;}
  return Math.sqrt(s/n);
}
function writeWavMono16(file,pcm,{sampleRate=16000}={}){
  const header=Buffer.alloc(44);
  header.write('RIFF',0);header.writeUInt32LE(36+pcm.length,4);header.write('WAVE',8);
  header.write('fmt ',12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);
  header.writeUInt32LE(sampleRate,24);header.writeUInt32LE(sampleRate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);
  header.write('data',36);header.writeUInt32LE(pcm.length,40);
  fs.writeFileSync(file,Buffer.concat([header,pcm]),{mode:0o600});
  try{fs.chmodSync(file,0o600);}catch{}
}

class UtteranceVad{
  constructor({onUtterance,energyFloor=0.008,silenceMs=700,minSpeechMs=350,maxSpeechMs=15000,preRollMs=300,gapMs=null}={}){
    this.onUtterance=onUtterance;this.energyFloor=energyFloor;this.silenceMs=silenceMs;
    this.minSpeechMs=minSpeechMs;this.maxSpeechMs=maxSpeechMs;this.preRollMs=preRollMs;
    this.gapMs=gapMs; // bounded wall-clock gap flush (null = off, chunk-driven only)
    this.gapTimer=null;this.lastAt=0;this.lastVoicedAt=0;this.flushGen=0;
    this.reset();
  }
  reset(){this.speaking=false;this.speechMs=0;this.silenceMsAcc=0;this.bufs=[];this.bytes=0;this.pre=[];this.preMs=0;this.noise=0;this.init=false;this.lastAt=0;this.lastVoicedAt=0;this.flushGen++;if(this.gapTimer){clearTimeout(this.gapTimer);this.gapTimer=null;}}
  dispose(){this.reset();}
  chunkMs(b){return b.length/32;} // 16kHz mono 16-bit
  armGap(){
    if(this.gapMs==null||!this.speaking)return;
    if(this.gapTimer)clearTimeout(this.gapTimer);
    const gen=this.flushGen;
    this.gapTimer=setTimeout(()=>{
      this.gapTimer=null;
      // Wall-clock gap with no frames at all (e.g. capture stops emitting):
      // flush exactly once through the shared choke point.
      if(gen!==this.flushGen||!this.speaking)return;
      if(Date.now()-this.lastAt>=this.gapMs)this.flushUtterance();
      else this.armGap();
    },this.gapMs);
    if(this.gapTimer.unref)this.gapTimer.unref();
  }
  flushUtterance(){ // single choke point: never a duplicate flush
    if(!this.speaking){this.reset();return;}
    this.flushGen++;
    if(this.speechMs>=this.minSpeechMs&&this.bufs.length){
      const pcm=Buffer.concat(this.bufs);
      const meta={endedAt:this.lastAt,voicedAt:this.lastVoicedAt,ms:this.speechMs};
      this.reset();
      try{const r=this.onUtterance&&this.onUtterance(pcm,meta);if(r&&r.catch)r.catch(()=>{});}catch{}
    }else this.reset(); // noise blip, discard
  }
  ingest(buf){
    if(!buf||!buf.length)return;
    const now=Date.now();this.lastAt=now;
    const ms=this.chunkMs(buf),energy=rmsEnergy(buf);
    if(!this.init){this.noise=Math.min(energy,this.energyFloor);this.init=true;}
    const enter=Math.max(this.energyFloor,this.noise*2.5),exit=Math.max(this.energyFloor*0.7,this.noise*1.6);
    const voiced=this.speaking?energy>=exit:energy>=enter;
    if(voiced)this.lastVoicedAt=now;
    if(!this.speaking){
      if(voiced){this.speaking=true;this.speechMs=0;this.silenceMsAcc=0;
        for(const p of this.pre){this.bufs.push(p);this.bytes+=p.length;}
        this.pre=[];this.preMs=0;this.bufs.push(buf);this.bytes+=buf.length;this.speechMs+=ms;
        this.armGap();
      }else{this.noise=this.noise*0.95+energy*0.05;this.pre.push(buf);this.preMs+=ms;
        while(this.preMs>this.preRollMs&&this.pre.length>1){const d=this.pre.shift();this.preMs-=this.chunkMs(d);}}
      return;
    }
    this.bufs.push(buf);this.bytes+=buf.length;
    if(voiced){this.speechMs+=ms;this.silenceMsAcc=0;}else{this.silenceMsAcc+=ms;}
    this.armGap();
    if((this.silenceMsAcc>=this.silenceMs&&this.speechMs>=this.minSpeechMs)||this.speechMs>=this.maxSpeechMs){
      this.flushUtterance();
    }else if(this.silenceMsAcc>=this.silenceMs&&this.speechMs<this.minSpeechMs){
      this.reset(); // noise blip, discard
    }
  }
  flush(){if(this.speaking&&this.speechMs>=this.minSpeechMs&&this.bufs.length){const pcm=Buffer.concat(this.bufs);const meta={endedAt:this.lastAt,voicedAt:this.lastVoicedAt,ms:this.speechMs};this.reset();return {pcm,meta};}this.reset();return null;}
}

function createLiveSession(deps={}){
  const emitter=new EventEmitter();
  const native=deps.native||require('./native');
  const runAnswer=deps.runAnswer||require('./runner').runAnswer;
  const getStore=deps.getStore;
  const getBackend=deps.getBackend;
  const transcribeImpl=deps.transcribe;
  const spawnWhisper=deps.spawnWhisper||spawn; // main-only test seam; never an IPC option
  const whisperConfig=deps.whisperConfig||configuration; // main-only test seam
  const state={
    phase:'idle', // idle|starting|live|pausing|paused|resuming
    epoch:0, briefId:null, app:'', allowSystem:false, withMic:false, scope:'',
    autoMode:true, depth:'', consent:false, recording:false, paused:false,
    recentQuestions:[], micContext:[], liveQA:[], history:[],
    pendingManual:'', inFlightQuestion:null, lastError:null,
    seq:0, activeCtl:null, activeSeq:0, sessionCtl:null,
    dropped:{interviewer:0,mic:0},
    counters:{frames:[0,0],bytes:[0,0],utterances:[0,0]}, lastCountersEmit:0,
  };
  let capture=null, captureSeq=0, activeCaptureId=0; // stable capture identity
  let whisperProc=null, whisperReady=false, stopGen=0, stopPromise=null;
  let whisperQueue=[], whisperPending=new Map(), whisperInflight=0, whisperSeq=0;
  let tmpDir=null, vadI=null, vadM=null, acc=createAccumulator({});
  let fileCounter=0;

  function setPhase(p){state.phase=p;emitter.emit('state',status());emitter.emit('status',status());}
  function status(){
    return {phase:state.phase,briefId:state.briefId,app:state.app,allowSystem:state.allowSystem,
      withMic:state.withMic,scope:state.scope,autoMode:state.autoMode,depth:state.depth,
      consent:state.consent,recording:state.recording,paused:state.paused,
      pendingManual:state.pendingManual,inFlightQuestion:state.inFlightQuestion,
      lastError:state.lastError,
      recentQuestions:state.recentQuestions.slice(-5).map(r=>r.text),
      micContext:state.micContext.slice(-3),
      history:state.history.slice(-8).map(h=>({question:h.question,at:h.at,auto:h.auto})),
      counters:{frames:[...state.counters.frames],bytes:[...state.counters.bytes],utterances:[...state.counters.utterances]},
      dropped:{...state.dropped},live:state.phase==='live'||state.phase==='paused'||state.phase==='starting'||state.phase==='pausing'||state.phase==='resuming'};
  }
  function noteError(text){
    state.lastError=String(text||'').slice(0,200);
  }
  function clearError(){state.lastError=null;}
  function countFrame(ch,n){
    const i=ch===1?1:0;
    state.counters.frames[i]++;state.counters.bytes[i]+=n;
    const now=Date.now();
    // Throttled to <=2Hz: scalar counters only, never PCM or transcripts.
    if(now-state.lastCountersEmit>=500){
      state.lastCountersEmit=now;
      emitter.emit('counters',{frames:[...state.counters.frames],bytes:[...state.counters.bytes],
        utterances:[...state.counters.utterances],dropped:{...state.dropped}});
    }
  }
  function ensureTmp(){
    if(tmpDir)return tmpDir;
    tmpDir=fs.mkdtempSync(path.join(os.tmpdir(),'opencluely-live-'));
    fs.chmodSync(tmpDir,0o700);
    return tmpDir;
  }
  function cleanupTmp(){
    if(!tmpDir)return;
    try{for(const f of fs.readdirSync(tmpDir)){try{fs.rmSync(path.join(tmpDir,f),{force:true});}catch{}}}catch{}
    try{fs.rmdirSync(tmpDir);}catch{}
    tmpDir=null;
  }
  function boundTmp(){
    if(!tmpDir)return;
    try{const files=fs.readdirSync(tmpDir).map(f=>({f,t:fs.statSync(path.join(tmpDir,f)).mtimeMs})).sort((a,b)=>a.t-b.t);
      while(files.length>MAX_TMP_WAVS){const old=files.shift();try{fs.rmSync(path.join(tmpDir,old.f),{force:true});}catch{}}}catch{}
  }
  function inTmpDir(wav){
    if(!tmpDir)return false;
    const resolved=path.resolve(wav),base=path.resolve(tmpDir);
    return resolved===base||resolved.startsWith(base+path.sep);
  }
  function whisperEnv(){
    return {PATH:'/opt/homebrew/bin:/usr/bin:/bin',HOME:os.homedir(),HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',OMP_NUM_THREADS:'2',MKL_NUM_THREADS:'2'};
  }
  function startWhisper(signal){
    if(transcribeImpl)return Promise.resolve(true);
    const cfg=whisperConfig();
    const model=cfg&&(cfg.model||cfg.modelPath);
    if(!cfg||!cfg.available||!model)throw Error('Existing Whisper runtime, cached model or audio decoder is unavailable. No installation or download was attempted.');
    ensureTmp();
    return new Promise((resolve,reject)=>{
      if(signal?.aborted)return reject(signal.reason||Error('Live start cancelled.'));
      const py=path.join(os.homedir(),'Library/Application Support/pipx/venvs/openai-whisper/bin/python');
      const script=(typeof __dirname!=='undefined'?path.join(__dirname,'transcribe-live.py'):'transcribe-live.py').replace(/app\.asar([/\\])/,'app.asar.unpacked$1');
      let child;
      try{child=spawnWhisper(py,[script,model],{stdio:['pipe','pipe','pipe'],env:whisperEnv()});}
      catch(e){return reject(Error('Live transcription process failed to start: '+(e.message||'').slice(0,200)));}
      whisperProc=child;whisperReady=false;whisperQueue=[];whisperPending=new Map();whisperInflight=0;
      let buf='';
      let startupTimer=setTimeout(()=>{if(!whisperReady)done(reject)(Error('Live transcription process did not become ready. No audio was sent to any network.'));},30000);
      if(startupTimer.unref)startupTimer.unref();
      const onAbort=()=>{try{child.kill('SIGKILL');}catch{}reject(signal.reason||Error('Live start cancelled.'));};
      signal?.addEventListener('abort',onAbort,{once:true});
      const done=(fn)=>(v)=>{signal?.removeEventListener('abort',onAbort);if(startupTimer){clearTimeout(startupTimer);startupTimer=null;}fn(v);};
      child.on('error',e=>{done(reject)(Error('Live transcription process failed to start: '+(e.message||'').slice(0,200)));});
      child.stderr.on('data',()=>{});
      child.stdout.on('data',d=>{
        buf+=d.toString();
        if(buf.length>MAX_STDOUT_BUF)buf=buf.slice(-MAX_STDOUT_BUF); // bounded
        let idx;while((idx=buf.indexOf('\n'))!==-1){
          const line=buf.slice(0,idx);buf=buf.slice(idx+1);
          if(!line.trim())continue;
          let msg;try{msg=JSON.parse(line);}catch{continue;}
          if(msg.ready&&!whisperReady){whisperReady=true;done(resolve)(true);pumpWhisper();continue;}
          const pend=whisperPending.get(msg.id);
          if(pend){whisperPending.delete(msg.id);clearTimeout(pend.timer);whisperInflight=Math.max(0,whisperInflight-1);
            if(msg.ok)pend.resolve(String(msg.text||'').slice(0,2000));else pend.resolve('');
            pumpWhisper();}
        }
      });
      child.on('exit',(code)=>{
        if(!whisperReady)done(reject)(Error('Live transcription process exited (code '+code+') before becoming ready. No download was attempted.'));
        else if(whisperProc===child){
          const error=Error('Local transcription stopped unexpectedly. Audio capture stopped.');
          noteError(error.message);emitter.emit('capture-error',error);
          stop().catch(()=>{});
        }
      });
    });
  }
  function drainWhisperQueue(){
    // Resolve (never hang) everything queued or in flight; callers check epoch.
    for(const item of whisperQueue){const p=whisperPending.get(item.id);if(p){whisperPending.delete(item.id);clearTimeout(p.timer);p.resolve('');}}
    whisperQueue=[];
    for(const [,p] of whisperPending){clearTimeout(p.timer);p.resolve('');}
    whisperPending=new Map();whisperInflight=0;
  }
  function transcribeWav(wavPath,channel){
    if(transcribeImpl)return transcribeImpl(wavPath,channel);
    if(!whisperProc||!whisperReady||!inTmpDir(wavPath))return Promise.resolve('');
    if(whisperQueue.length+whisperPending.size>=MAX_QUEUE){
      // Bounded: resolve the oldest dropped job instead of hanging it.
      const dropped=whisperQueue.shift();
      if(dropped){const p=whisperPending.get(dropped.id);if(p){whisperPending.delete(dropped.id);clearTimeout(p.timer);p.resolve('');}}
      state.dropped[channel==='mic'?'mic':'interviewer']++;
    }
    return new Promise((resolve)=>{
      const id='u'+(++whisperSeq)+'-'+crypto.randomUUID().slice(0,8);
      const timer=setTimeout(()=>{if(whisperPending.delete(id)){whisperInflight=Math.max(0,whisperInflight-1);resolve('');pumpWhisper();}},60000);
      if(timer.unref)timer.unref();
      whisperPending.set(id,{resolve,timer});
      whisperQueue.push({id,wavPath,channel});
      pumpWhisper();
    });
  }
  function pumpWhisper(){
    // Serialized: exactly one transcription in flight.
    if(!whisperProc||!whisperReady||whisperInflight>0)return;
    const item=whisperQueue.shift();
    if(!item)return;
    if(!whisperPending.has(item.id)){pumpWhisper();return;}
    whisperInflight++;
    try{whisperProc.stdin.write(JSON.stringify({id:item.id,wav:item.wavPath,channel:item.channel})+'\n');}
    catch{const p=whisperPending.get(item.id);if(p){whisperPending.delete(item.id);clearTimeout(p.timer);}whisperInflight=Math.max(0,whisperInflight-1);}
  }
  function pruneRecent(now=Date.now()){
    state.recentQuestions=state.recentQuestions.filter(r=>now-r.at<RECENT_TTL_MS).slice(-MAX_RETAINED_QUESTIONS);
  }
  function evaluateCandidate(full,{auto}){
    const check=isQuestionCandidate(full);
    if(!check.isQuestion){emitter.emit('statement',{text:full});return null;}
    if(!state.autoMode&&auto){
      // Manual mode: never call the provider automatically. Retain the text.
      state.pendingManual=full.slice(0,4000);
      emitter.emit('question-pending',{question:full});
      emitter.emit('state',status());
      return null;
    }
    return full;
  }
  async function handleUtterance(pcm,channel,epochAtCapture,meta={}){
    if(epochAtCapture!==state.epoch||state.phase!=='live')return; // stale: discarded
    if(!pcm||pcm.length<3200)return;
    if(pcm.length>2*1024*1024)return;
    const ci=channel==='mic'?1:0;
    state.counters.utterances[ci]++;
    // Bounded scalar-only pipeline timing (single Date clock): VAD last
    // voiced/sample end -> STT -> dispatch -> first model delta -> accepted.
    // No transcripts or audio are retained here.
    const voicedAt=typeof meta.voicedAt==='number'&&meta.voicedAt>0?meta.voicedAt:Date.now();
    ensureTmp();boundTmp();
    const name=`utt-${channel}-${Date.now()}-${(fileCounter++).toString(36)}.wav`;
    const wav=path.join(tmpDir,name);
    try{writeWavMono16(wav,pcm);}catch{return;}
    const tStt0=Date.now();
    let text='';
    try{text=normalize(await transcribeWav(wav,channel));}finally{try{fs.rmSync(wav,{force:true});}catch{}}
    const tStt1=Date.now();
    // Epoch/phase re-check AFTER the await: delayed results cannot fire late.
    if(epochAtCapture!==state.epoch||state.phase!=='live')return;
    if(!text)return;
    if(channel==='mic'){
      state.micContext.push(text.slice(0,500));
      if(state.micContext.length>6)state.micContext.shift();
      emitter.emit('transcript',{channel:'mic',text,contextOnly:true});
      return;
    }
    emitter.emit('transcript',{channel:'interviewer',text,raw:true,unverified:true});
    const e0=state.epoch;
    const pushed=acc.push(text,(flushed)=>{ // evaluated flush: nothing is dropped
      try{
        if(e0!==state.epoch||state.phase!=='live')return;
        const f=normalize(flushed);if(!f)return;
        const q=evaluateCandidate(f,{auto:true});
        if(q)askQuestionDispatch(q,{auto:true,t0:{voicedAt,tStt0,tStt1,tDisp0:Date.now()}}).catch(()=>{});
      }catch{}
    });
    if(pushed.buffered)return;
    const full=normalize(pushed.text||text);
    if(!full)return;
    const q=evaluateCandidate(full,{auto:true});
    if(q){const tDisp0=Date.now();await askQuestionDispatch(q,{auto:true,t0:{voicedAt,tStt0,tStt1,tDisp0}});}
  }
  async function askQuestionDispatch(question,{auto=true,force=false,t0=null}={}){
    pruneRecent();
    if(!force){
      // Same question already being generated: never abort/restart itself.
      if(state.inFlightQuestion&&normalize(state.inFlightQuestion).toLowerCase()===normalize(question).toLowerCase()){
        emitter.emit('duplicate',{text:question,inFlight:true});
        return null;
      }
      if(isDuplicate(question,state.recentQuestions)){emitter.emit('duplicate',{text:question});return null;}
    }
    // Remember at dispatch (not only on accepted completion).
    state.recentQuestions.push({text:question,at:Date.now()});
    pruneRecent();
    return askQuestion(question,{auto,t0});
  }
  async function askQuestion(question,{auto=true,depthOverride,t0=null}={}){
    if(state.phase!=='live'&&state.phase!=='paused')throw Error('Start a live session before generating answers.');
    if(typeof question!=='string'||!question.trim()||question.length>4000)throw Error('Enter a question under 4,000 characters.');
    const e0=state.epoch;
    const seq=++state.seq;
    if(state.activeCtl){try{state.activeCtl.abort();}catch{}}
    const ctl=new AbortController();state.activeCtl=ctl;state.activeSeq=seq;
    state.inFlightQuestion=question;
    const depth=depthOverride!==undefined?depthOverride:state.depth;
    emitter.emit('question',{question,auto,seq});
    try{
      if(!getStore||!getBackend)throw Error('Live answer backend is not wired.');
      const store=getStore();
      const brief=store.getBrief(state.briefId);
      const profile=store.getProfile();
      // Company-scoped live Q/A history + mic speech as explicitly untrusted
      // dialogue (never verified personal accomplishment).
      const liveHistory=state.liveQA.slice(-4).map(h=>({question:h.question,answer:h.answer}));
      const q=question+(state.micContext.length?`\n[My spoken context, not the question (untrusted): ${state.micContext.slice(-2).join(' / ').slice(0,400)}]`:'');
      const backend=getBackend();
      const tStart=Date.now();let firstDelta=null,firstDeltaAt=0,raw='';
      const rawOut=await runAnswer({profile,brief,question:q,liveHistory,depth,backend,signal:ctl.signal,
        onDelta:d=>{if(state.activeSeq!==seq||e0!==state.epoch)return;if(firstDelta===null){firstDelta=Date.now()-tStart;firstDeltaAt=Date.now();}raw+=d;emitter.emit('answer-delta',{seq,delta:d,question,unverified:true});}});
      // Stale generations never override the latest answer.
      if(state.activeSeq!==seq||e0!==state.epoch)return null;
      const tAccepted=Date.now();
      state.liveQA.push({question,answer:rawOut.answer.opening.slice(0,400)});
      if(state.liveQA.length>8)state.liveQA.shift();
      state.history.push({question,answer:rawOut.answer.opening,at:new Date().toISOString(),auto});
      if(state.history.length>30)state.history.shift();
      // Bounded scalar-only end-to-end pipeline timing. firstDeltaAt is the
      // first MODEL delta; the first visible talking point is measured
      // separately in the UI and labeled honestly.
      let pipeline=null;
      if(t0&&typeof t0.voicedAt==='number'){
        pipeline={vadVoicedToSttStartMs:t0.tStt0-t0.voicedAt,sttMs:t0.tStt1-t0.tStt0,
          sttToDispatchMs:t0.tDisp0-t0.tStt1,dispatchToFirstDeltaMs:firstDeltaAt>0?firstDeltaAt-t0.tDisp0:null,
          firstDeltaToAcceptedMs:firstDeltaAt>0?tAccepted-firstDeltaAt:null,
          voicedToFirstDeltaMs:firstDeltaAt>0?firstDeltaAt-t0.voicedAt:null,
          voicedToAcceptedMs:tAccepted-t0.voicedAt};
      }
      emitter.emit('answer',{seq,question,answer:rawOut.answer,evidence:rawOut.evidence,timing:rawOut.timing,raw,pipeline,verified:true,auto});
      emitter.emit('state',status()); // overlay history updates on accept
      return rawOut;
    }catch(e){
      if(e0!==state.epoch||ctl.signal.aborted||/abort|cancel/i.test(e.message||'')){emitter.emit('answer-cancelled',{seq,question});return null;}
      noteError(e.message||e);
      emitter.emit('answer-error',{seq,question,error:String(e.message||e).slice(0,500)});
      throw e;
    }finally{
      if(state.activeSeq===seq){state.activeCtl=null;state.inFlightQuestion=null;}
    }
  }

  async function cleanupCapture(){
    const cap=capture;capture=null;
    if(cap){try{await cap.stop();}catch{}}
  }
  // Retain the child handle, await a bounded exit, then SIGKILL. Never nulls
  // the handle before the kill decision, so no child survives.
  async function terminateWhisper(){
    drainWhisperQueue();
    const child=whisperProc;whisperProc=null;whisperReady=false;
    if(!child||transcribeImpl)return;
    if(child.exitCode!=null||child.signalCode!=null)return;
    try{child.kill('SIGTERM');}catch{}
    await new Promise(res=>{
      let done=false;
      const finish=()=>{if(!done){done=true;res();}};
      child.once('exit',finish);
      const t=setTimeout(finish,2000);
      if(t.unref)t.unref();
    });
    try{child.kill('SIGKILL');}catch{}
  }
  function cleanupWhisper(){ drainWhisperQueue(); }
  async function start({briefId,app='',allowSystem=false,withMic=false,consent=false,autoMode=true,depth=''}={}){
    if(state.phase!=='idle')throw Error('A live session is already running. Stop it first.');
    if(consent!==true)throw Error('Participant consent and interviewer rules must be confirmed before live assistance.');
    if(typeof briefId!=='string'||!briefId)throw Error('Select a company brief before starting a live session.');
    if(!getStore)throw Error('Live session storage is not wired.');
    const validated=native.validateRunOptions?native.validateRunOptions({app,withMic,allowSystem}):{app:withMic===true?app:app,withMic,allowSystem};
    if(typeof autoMode!=='boolean')throw Error('Invalid auto/manual option.');
    if(depth!==''&&depth!=='shorter'&&depth!=='deeper')throw Error('Invalid response depth.');
    const store=getStore();
    store.getBrief(briefId);
    try{store.saveSelection({selectedBriefId:briefId});}catch{}
    // Phase 'starting' immediately: concurrent Start is rejected and Stop works.
    state.epoch++;
    Object.assign(state,{phase:'starting',briefId,app:validated.app,allowSystem:validated.allowSystem,
      withMic:validated.withMic,scope:'',autoMode,depth,consent:true,recording:false,paused:false,
      recentQuestions:[],micContext:[],liveQA:[],history:[],pendingManual:'',inFlightQuestion:null,
      activeCtl:null});
    state.sessionCtl=new AbortController();
    const signal=state.sessionCtl.signal;
    setPhase('starting');
    acc=createAccumulator({});
    // VAD callbacks use the CURRENT epoch at utterance-fire time for the new
    // utterance; delayed STT results stay epoch-guarded inside handleUtterance.
    const wrap=(ch)=>({onUtterance:(pcm,meta)=>{handleUtterance(pcm,ch,state.epoch,meta||{}).catch(()=>{});}});
    // Wall-clock gap flush: if the capture stops emitting frames entirely,
    // the pending utterance still flushes. Chunk-driven silence still rules
    // the healthy continuously-silent pipeline.
    vadI=new UtteranceVad({...wrap('interviewer'),silenceMs:700,gapMs:700});
    vadM=new UtteranceVad({...wrap('mic'),silenceMs:700,gapMs:700});
    // Stable capture identity: callbacks carry this start's id and are
    // rejected once a newer start (or stop) supersedes them.
    const capId=++captureSeq;activeCaptureId=capId;
    try{
      await startWhisper(signal); // throws on load failure/exit/timeout; cleans up
      if(signal.aborted)throw signal.reason||Error('Live start cancelled.');
      capture=native.startCapture({app:validated.app,allowSystem:validated.allowSystem,withMic:validated.withMic,
        onFrame:(ch,pcm)=>{
          // Survives pause/resume: only the live phase with the current
          // capture identity ingests; pausing/resuming phases drop frames.
          if(state.phase!=='live'||capId!==activeCaptureId)return;
          if(ch===0){countFrame(0,pcm.length);if(vadI)vadI.ingest(Buffer.from(pcm));}
          else if(validated.withMic&&vadM){countFrame(1,pcm.length);vadM.ingest(Buffer.from(pcm));}
        },
        onScope:info=>{if(capId!==activeCaptureId)return;state.scope=String(info.scope||state.scope||'');emitter.emit('state',status());},
        onStderr:()=>{},
        onError:(e)=>{if(capId!==activeCaptureId||state.phase==='idle')return;noteError(e&&e.message||e);emitter.emit('capture-error',e);}});
      const info=await capture.ready; // actual readiness, not merely spawned
      void info;
      if(signal.aborted)throw signal.reason||Error('Live start cancelled.');
      if(capture&&capture.process){
        capture.process.on('exit',(code)=>{
          if(capId!==activeCaptureId)return;
          if(state.phase==='live'||state.phase==='paused'||state.phase==='pausing'||state.phase==='resuming'){
            const err=(capture&&capture.errors()||'').slice(-600);
            noteError(err);
            stop().catch(()=>{});
            emitter.emit('capture-error',Error(permissionMessage(err)||'Native audio capture exited (code '+code+'). No audio was captured.'));
          }
        });
      }
      state.recording=true; // true only after helper ready
      clearError(); // stale capture errors do not survive a new session
      state.counters={frames:[0,0],bytes:[0,0],utterances:[0,0]};state.lastCountersEmit=0;
      setPhase('live');
      return status();
    }catch(e){
      await stop().catch(()=>{});
      if(signal?.aborted||/cancel/i.test(e.message||''))throw Error('Live start cancelled. No audio was captured.');
      throw e;
    }
  }
  function permissionMessage(errText){
    if(/Screen Recording|System Audio/i.test(errText))return 'Screen Recording / System Audio permission was not granted. Open System Settings > Privacy & Security > Screen Recording & System Audio, enable this app, relaunch it, then retry. No audio was captured.';
    if(/Microphone/i.test(errText))return 'Microphone permission was not granted. Open System Settings > Privacy & Security > Microphone, allow this app, then retry. No audio was captured.';
    if(/not found among running apps/i.test(errText))return errText.slice(0,400);
    return '';
  }
  async function pause(){
    if(state.phase!=='live')throw Error('No live session to pause.');
    const g0=stopGen;
    setPhase('pausing'); // frames drop (not live) while the ack is awaited
    state.epoch++; // delayed transcription can no longer fire
    state.activeSeq++;
    try{state.activeCtl&&state.activeCtl.abort();}catch{}
    state.activeCtl=null;state.inFlightQuestion=null;
    drainWhisperQueue(); // abort pending STT, discard queued audio
    try{acc.cancel();}catch{}
    try{vadI&&vadI.reset();vadM&&vadM.reset();}catch{}
    // Audio stops promptly: request the pause ack concurrently with teardown.
    const pauseAck=capture?capture.pause():Promise.resolve(true);
    pauseAck.catch(()=>{});
    try{await terminateWhisper();}catch{} // STT process torn down on pause
    try{await pauseAck;}catch(e){
      // Stop won the race: stay idle, never set paused after stop.
      if(g0!==stopGen||state.phase!=='pausing')return status();
      noteError('Pause could not be confirmed. Capture stopped.');
      await stop();
      throw e;
    }
    if(g0!==stopGen||state.phase!=='pausing')return status();
    state.paused=true;
    state.recording=false; // acked: no active capture while paused
    setPhase('paused');
    return status();
  }
  async function resume(){
    if(state.phase!=='paused')throw Error('No paused session to resume.');
    const g0=stopGen;
    setPhase('resuming'); // frames drop until live again
    try{
      if(!transcribeImpl&&state.sessionCtl&&!state.sessionCtl.signal.aborted){
        await startWhisper(state.sessionCtl.signal); // restore STT; dialogue preserved
      }
      if(g0!==stopGen||state.phase!=='resuming')throw Error('Live session was stopped.');
      if(capture){await capture.resume();} // acknowledged by helper
      if(g0!==stopGen||state.phase!=='resuming')throw Error('Live session was stopped.');
      state.paused=false;
      state.recording=true; // acked: capture active again
      setPhase('live');
      return status();
    }catch(e){
      if(g0!==stopGen||state.phase==='idle')throw Error('Live session was stopped.');
      noteError('Resume could not be confirmed. Capture stopped.');
      await stop();
      throw e;
    }
  }
  async function stop(){
    if(state.phase==='idle')return status();
    if(stopPromise)return stopPromise; // concurrent stops share one teardown
    stopPromise=(async()=>{
      stopGen++;
      activeCaptureId=0; // invalidate every capture callback immediately
      state.epoch++; // a cancellation-ignoring backend cannot emit afterwards
      state.activeSeq++;
      try{state.sessionCtl&&state.sessionCtl.abort();}catch{}
      state.sessionCtl=null;
      try{state.activeCtl&&state.activeCtl.abort();}catch{}
      state.activeCtl=null;state.inFlightQuestion=null;
      await cleanupCapture();
      await terminateWhisper(); // bounded SIGTERM exit wait, then SIGKILL
      try{if(vadI&&vadI.dispose)vadI.dispose();else if(vadI)vadI.reset();}catch{}
      try{if(vadM&&vadM.dispose)vadM.dispose();else if(vadM)vadM.reset();}catch{}
      vadI=null;vadM=null;
      try{acc.cancel();}catch{}
      cleanupTmp();
      state.recording=false;state.paused=false;state.consent=false;state.pendingManual='';
      setPhase('idle');
      return status();
    })().finally(()=>{stopPromise=null;});
    return stopPromise;
  }
  function injectFrame(channel,pcm){
    if(channel===0&&vadI)vadI.ingest(Buffer.from(pcm));
    else if(channel===1&&vadM)vadM.ingest(Buffer.from(pcm));
  }
  return {on:(ev,fn)=>emitter.on(ev,fn),status,start,pause,resume,stop,dispatch:(q,opts)=>askQuestionDispatch(q,{auto:true,...(opts||{})}),
    generate:(q,opts)=>askQuestionDispatch(q,{auto:false,force:true,...(opts||{})}),
    setAuto:v=>{state.autoMode=!!v;emitter.emit('state',status());return status();},
    setDepth:d=>{if(d!==''&&d!=='shorter'&&d!=='deeper')throw Error('Invalid depth.');state.depth=d;emitter.emit('state',status());return status();},
    injectFrame,_internals:{state,rmsEnergy,UtteranceVad}};
}

module.exports={createLiveSession,UtteranceVad,rmsEnergy,MAX_QUEUE};
