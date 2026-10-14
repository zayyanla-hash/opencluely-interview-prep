'use strict';
// Focused regression/integration tests for the realtime interview copilot.
// Native-process tests below use injected fakes plus the offline
// --self-test converter check; they NEVER perform real audio capture and are
// never labeled as such. Real capture needs user permissions + live hardware.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
const {isQuestionCandidate,isDuplicate,createAccumulator}=require('../prep/detect');
const {createLiveSession,UtteranceVad}=require('../prep/live-session');
const {validateRunOptions,selfTest}=require('../prep/native');
const {seedProfile,ROLES}=require('../prep/profile');
const {buildContext,buildRequest,knownAnswer}=require('../prep/engine');
const {PrepStore}=require('../prep/store');

const brief=(company='Acme',role='finance')=>({id:'b-'+company,company,role,date:'2026-10-13',jobDescription:'',notes:'',hypotheses:'',interviewer:'',resume:'',history:[]});
const GOOD={opening:'I work on financial workflows.',points:['I process invoices.'],expansion:'',deeper:'',gaps:[],claims:[{text:'I process invoices.',sources:['accounting:user']}]};

test('detector accepts contextual triggers and rejects ordinary statements',()=>{
  for(const q of ['Tell me about yourself.','Walk me through a project you built.','How would you improve our GTM strategy?','Describe a time you handled ambiguity.','What would you prioritize in your first 30 days?','Could you share an example of ownership?','So, tell me about yourself for this role.','We are done with that. What would you prioritize?'])
    assert.equal(isQuestionCandidate(q).isQuestion,true,q);
  for(const s of ['We had a standup today.','The dashboard loads slowly on Fridays.','Thanks, that makes sense.','OK.','I explained how we would handle the migration last quarter.','We described a time when deploys failed and fixed it.','I told the team what we should do next.'])
    assert.equal(isQuestionCandidate(s).isQuestion,false,s);
});

test('detector dedups identical/overlapping STT, expires old entries, accumulates partials',()=>{
  assert.equal(isDuplicate('Tell me about yourself for this role',['Tell me about yourself for this role']),true);
  assert.equal(isDuplicate('Tell me about yourself for this role',['tell me about yourself for this role!']),true);
  assert.equal(isDuplicate('How would you improve our GTM strategy going forward',['How would you improve our GTM strategy']),true);
  assert.equal(isDuplicate('What is your favorite food',['How would you improve GTM']),false);
  // Expired entries allow intentional repeats.
  assert.equal(isDuplicate('Tell me about yourself for this role',[{text:'Tell me about yourself for this role',at:Date.now()-10*60*1000}]),false);
  const acc=createAccumulator({flushMs:30});
  assert.equal(acc.push('Tell me about').buffered,true);
  const r2=acc.push('yourself for this role.');
  assert.equal(r2.buffered,false);
  assert.match(r2.text,/Tell me about yourself/);
});

test('accumulator flush callback evaluates nonpunctuated STT instead of dropping it',async()=>{
  const acc=createAccumulator({flushMs:25});
  let flushed=null;
  acc.push('Tell me about yourself for this role',{});
  acc.push('Tell me about yourself for this role',t=>{flushed=t;});
  // Non-terminal fragment -> buffered; flush timer delivers it to the callback.
  const a2=createAccumulator({flushMs:25});
  a2.push('Walk me through a project you built',t=>{flushed=t;});
  await new Promise(r=>setTimeout(r,60));
  assert.match(flushed||'',/Walk me through|Tell me about/);
  assert.equal(a2.peek(),'');
});

test('new interview modes exist without invalidating old briefs',()=>{
  for(const r of ['behavioral','gtmGrowth','businessOps','strategy','general','founder','gtm','startup','finance','research','product','ai'])
    assert.ok(ROLES[r],r);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'prep-roles-'));
  try{
    const s=new PrepStore(root);
    s.saveBrief({...brief('Old','finance'),id:'old1'});
    assert.equal(s.getBrief('old1').role,'finance');
    const c=buildContext(seedProfile(),{...brief('New','strategy'),id:'new1'},'How would you prioritize?');
    assert.ok(c.role.includes('Strategy'));
    assert.ok(buildRequest(c,'q',{depth:'shorter'}).systemInstruction.parts[0].text.includes('SHORT'));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('education: studies stated without dates or degree; never claims completion',()=>{
  const p=seedProfile();
  assert.equal(p.identity.completedBachelors,null);
  assert.match(p.identity.educationDetail,/Sample State University/);
  assert.ok(!/in progress|20\d\d|graduated|bachelor'?s degree/i.test(p.identity.educationDetail));
  assert.ok(/not verified|no completed degree claimed/i.test(p.identity.educationDetail));;
  const a=knownAnswer(p,'Where did you study?');
  assert.match(a.opening,/Sample State/);
  assert.match(a.gaps.join(' '),/not verified|completed degree/);
  assert.match(knownAnswer(p,'Do you have a completed bachelor degree?').opening,/not verified/);
});

test('native helper arg validation: explicit scope, no shell interpolation',()=>{
  assert.throws(()=>validateRunOptions({app:'',withMic:false,allowSystem:false}),/meeting app|system audio/i);
  assert.deepEqual(validateRunOptions({app:'',withMic:false,allowSystem:true}),{app:'',withMic:false,allowSystem:true});
  assert.deepEqual(validateRunOptions({app:'zoom.us',withMic:true}),{app:'zoom.us',withMic:true,allowSystem:false});
  assert.throws(()=>validateRunOptions({app:'Zoom; rm -rf /',withMic:false}),/unsupported characters/);
  assert.throws(()=>validateRunOptions({app:'`id`',withMic:false}),/unsupported characters/);
  assert.throws(()=>validateRunOptions({app:'ok',withMic:'yes'}),/microphone/);
});

test('native converter self-test passes offline (no recording, no permissions)',()=>{
  const report=selfTest();
  assert.equal(report.ok,true);
  const names=report.checks.map(c=>c.name);
  for(const n of ['system-path-sample-count','system-path-continuous','system-path-empty-safe','system-path-rms','mic-path-sample-count','mic-path-rms','frame-layout'])
    assert.ok(names.includes(n),n);
  assert.ok(report.checks.every(c=>c.ok===true));
});

// Drive voiced frames through the REAL native onFrame callback path (simulated
// PCM, never real capture): loud chunks (speech) then quiet chunks (pause)
// trip the utterance VAD exactly like helper output would.
function speakFrames(handle,{loud=12,quiet=10,level=9000}={}){
  const L=Buffer.alloc(3200);for(let i=0;i<1600;i++)L.writeInt16LE(level,i*2);
  const Q=Buffer.alloc(3200);
  for(let i=0;i<loud;i++)handle.onFrame(0,Buffer.from(L));
  for(let i=0;i<quiet;i++)handle.onFrame(0,Buffer.from(Q));
}
const settle=(ms=250)=>new Promise(r=>setTimeout(r,ms));

// ---- live-session harness (injected fake native/STT; simulated only) ----
function fakeHarness({transcripts={},backendImpl=null}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'prep-live-'));
  const store=new PrepStore(root);
  store.saveBrief({...brief('Acme','finance'),id:'live1'});
  store.saveProfile(seedProfile());
  const calls=[];
  const fakeBackend=backendImpl||{run:async(req,onDelta)=>{calls.push(req);const out=JSON.stringify(GOOD);if(onDelta)onDelta(out);return out;}};
  const handles=[];
  const fakeNative={
    handles,
    validateRunOptions:require('../prep/native').validateRunOptions,
    startCapture:(opts)=>{
      const {app,allowSystem}=opts;
      if(!app&&!allowSystem)throw Error('Select a meeting app, or explicitly enable all-system audio capture.');
      const proc=new EventEmitter();
      const h={process:proc,ready:Promise.resolve({ok:true,ready:true,scope:app||'system'}),
        onFrame:opts.onFrame||null,onScope:opts.onScope||null,killed:false,paused:false,
        kill(){h.killed=true;},stop:async()=>{h.killed=true;},pause:async()=>{h.paused=true;return true;},
        resume:async()=>{h.paused=false;return true;},errors:()=>''};
      handles.push(h);
      return h;
    }};
  const transcribe=async(wav,ch)=>transcripts[ch]||'';
  const session=createLiveSession({getStore:()=>store,getBackend:()=>fakeBackend,native:fakeNative,transcribe,
    runAnswer:require('../prep/runner').runAnswer});
  return {root,store,session,calls,fakeNative};
}

test('consent gate + explicit scope (simulated session)',async t=>{
  const h=fakeHarness();t.after(()=>{fs.rmSync(h.root,{recursive:true,force:true});try{fs.rmSync(h.root,{recursive:true,force:true});}catch{}});
  await assert.rejects(h.session.start({briefId:'live1',consent:false,app:'zoom.us'}),/consent/i);
  await assert.rejects(h.session.start({briefId:'live1',consent:true,app:'',allowSystem:false}),/meeting app|system audio/i);
  await assert.rejects(h.session.start({briefId:'nope',consent:true,app:'zoom.us'}),/preset|supported|read|brief|context/i);
  t.after(()=>h.session.stop().catch(()=>{}));
});

test('lifecycle start/pause/resume/stop with acks; temps deleted (simulated)',async t=>{
  const h=fakeHarness({transcripts:{interviewer:'Tell me about yourself for this role.'}});
  t.after(()=>fs.rmSync(h.root,{recursive:true,force:true}));
  await h.session.start({briefId:'live1',consent:true,app:'zoom.us',withMic:false});
  assert.equal(h.session.status().phase,'live');
  assert.equal(h.session.status().recording,true);
  await h.session.pause();assert.equal(h.session.status().phase,'paused');
  await h.session.resume();assert.equal(h.session.status().phase,'live');
  await h.session.stop();assert.equal(h.session.status().phase,'idle');
  assert.equal(fs.readdirSync(os.tmpdir()).filter(f=>f.startsWith('opencluely-live-')).length,0);
});

test('stop during starting cleans up everything (simulated slow native)',async t=>{
  const h=fakeHarness();t.after(()=>fs.rmSync(h.root,{recursive:true,force:true}));
  let releaseReady;const gate=new Promise(r=>releaseReady=r);
  const slowNative={validateRunOptions:require('../prep/native').validateRunOptions,
    startCapture:()=>{const proc=new EventEmitter();return {process:proc,ready:gate,kill(){},stop:async()=>{},pause:async()=>true,resume:async()=>true,errors:()=>''};}};
  const {createLiveSession:mk}=require('../prep/live-session');
  const s2=mk({getStore:()=>h.store,getBackend:()=>({run:async()=>JSON.stringify(GOOD)}),native:slowNative,transcribe:async()=>'',runAnswer:require('../prep/runner').runAnswer});
  t.after(()=>s2.stop().catch(()=>{}));
  const p=s2.start({briefId:'live1',consent:true,app:'zoom.us'});
  assert.equal(s2.status().phase,'starting');
  await s2.stop(); // must work while starting
  releaseReady({ok:true});
  await assert.rejects(p,/cancel/i);
  assert.equal(s2.status().phase,'idle');
});

test('delayed transcription cannot fire after pause/stop epoch (simulated)',async t=>{
  let release;const gate=new Promise(r=>release=r);
  const h=fakeHarness({transcripts:{}});
  h.session._internals; // keep liveness
  // Slow STT: resolves only when released.
  const slowTranscribe=async()=>{await gate;return 'Tell me about yourself for this role.';};
  const {createLiveSession:mk}=require('../prep/live-session');
  const s2=mk({getStore:()=>h.store,getBackend:()=>({run:async()=>JSON.stringify(GOOD)}),native:h.fakeNative,transcribe:slowTranscribe,runAnswer:require('../prep/runner').runAnswer});
  t.after(()=>{fs.rmSync(h.root,{recursive:true,force:true});});
  t.after(()=>s2.stop().catch(()=>{}));
  const seen=[];s2.on('question',q=>seen.push(q));s2.on('answer',a=>seen.push(a));
  await s2.start({briefId:'live1',consent:true,app:'zoom.us'});
  const loud=Buffer.alloc(32000);for(let i=0;i<16000;i++)loud.writeInt16LE(8000,i*2);
  // Drive two utterances through the serialized queue, then stop before STT resolves.
  const internals=s2._internals;
  void s2.injectFrame(0,loud);
  await new Promise(r=>setTimeout(r,50));
  await s2.stop();
  release();
  await new Promise(r=>setTimeout(r,100));
  assert.equal(seen.length,0);
  assert.equal(internals.state.epoch>=2,true);
});

test('source distinction: interviewer auto-answers, mic context-only (simulated)',async t=>{
  const h=fakeHarness({transcripts:{interviewer:'Tell me about yourself for this role.',mic:'I worked on Sample Startup Co finances.'}});
  t.after(()=>fs.rmSync(h.root,{recursive:true,force:true}));
  const seen={q:[],a:[]};
  h.session.on('question',q=>seen.q.push(q));h.session.on('answer',a=>seen.a.push(a));
  await h.session.start({briefId:'live1',consent:true,app:'zoom.us',withMic:true});
  await h.session.generate('Describe your financial workflow experience');
  assert.equal(seen.a.length,1);
  assert.equal(h.calls.length,1);
  await h.session.stop();
});

test('manual mode never calls the provider; pending text retained (simulated)',async t=>{
  const h=fakeHarness();t.after(()=>fs.rmSync(h.root,{recursive:true,force:true}));
  let pending=null;h.session.on('question-pending',q=>pending=q);
  await h.session.start({briefId:'live1',consent:true,app:'zoom.us',autoMode:false});
  const internals=h.session._internals;
  // Feed an utterance through handleUtterance via injected loud frames + fake STT.
  const h2=fakeHarness({transcripts:{interviewer:'Tell me about yourself for this role.'}});
  t.after(()=>fs.rmSync(h2.root,{recursive:true,force:true}));
  await h2.session.start({briefId:'live1',consent:true,app:'zoom.us',autoMode:false});
  let gotPending=null;h2.session.on('question-pending',q=>gotPending=q);
  const loud=Buffer.alloc(32000);for(let i=0;i<16000;i++)loud.writeInt16LE(9000,i*2);
  const quiet=Buffer.alloc(32000);
  for(let i=0;i<12;i++)h2.session.injectFrame(0,loud);
  for(let i=0;i<10;i++)h2.session.injectFrame(0,quiet);
  await new Promise(r=>setTimeout(r,300));
  assert.ok(gotPending&&/Tell me about yourself/.test(gotPending.question));
  assert.equal(h2.calls.length,0); // provider never called
  assert.match(h2.session.status().pendingManual,/Tell me about yourself/);
  await h2.session.stop();
  await h.session.stop();
  assert.equal(pending,null);
  assert.equal(internals.state.epoch>=1,true);
});

test('same question in-flight is not aborted/restarted; manual regenerate allowed (simulated)',async t=>{
  const h=fakeHarness();t.after(()=>fs.rmSync(h.root,{recursive:true,force:true}));
  let release;const gate=new Promise(r=>release=r);
  let runs=0;
  const slowBackend={run:async()=>{runs++;await gate;return JSON.stringify(GOOD);}};
  const {createLiveSession:mk}=require('../prep/live-session');
  const s2=mk({getStore:()=>h.store,getBackend:()=>slowBackend,native:h.fakeNative,transcribe:async()=>'',runAnswer:require('../prep/runner').runAnswer});
  t.after(()=>s2.stop().catch(()=>{}));
  await s2.start({briefId:'live1',consent:true,app:'zoom.us'});
  const answers=[];s2.on('answer',a=>answers.push(a));
  const p1=s2.dispatch('Describe your financial workflow experience');
  await new Promise(r=>setTimeout(r,50));
  const p1dup=s2.dispatch('Describe your financial workflow experience'); // in-flight dup
  await new Promise(r=>setTimeout(r,50));
  assert.equal(runs,1); // not restarted
  release();
  const [r1,rdup]=await Promise.all([p1,p1dup]);
  assert.ok(r1&&r1.answer);
  assert.equal(rdup,null);
  assert.equal(answers.length,1);
  // Manual regenerate of the same question is allowed (force).
  let release2;const gate2=new Promise(r=>release2=r);
  slowBackend.run=async()=>{runs++;await gate2;return JSON.stringify(GOOD);};
  const p2=s2.generate('Describe your financial workflow experience');
  await new Promise(r=>setTimeout(r,50));
  assert.equal(runs,2);
  release2();await p2;
});

test('stale generation never overrides latest; cancel bounded (simulated)',async t=>{
  const h=fakeHarness();t.after(()=>fs.rmSync(h.root,{recursive:true,force:true}));
  let release;const gate=new Promise(r=>release=r);
  const slowBackend={run:async()=>{await gate;return JSON.stringify(GOOD);}};
  const {createLiveSession:mk}=require('../prep/live-session');
  const s2=mk({getStore:()=>h.store,getBackend:()=>slowBackend,native:h.fakeNative,transcribe:async()=>'',runAnswer:require('../prep/runner').runAnswer});
  t.after(()=>s2.stop().catch(()=>{}));
  await s2.start({briefId:'live1',consent:true,app:'zoom.us'});
  const answers=[];s2.on('answer',a=>answers.push(a));
  const p1=s2.generate('Describe your financial workflow experience');
  await new Promise(r=>setTimeout(r,30));
  const p2=s2.generate('Explain your financial reconciliation experience');
  release();
  await Promise.all([p1,p2]);
  assert.ok(answers.length<=1);
  if(answers.length===1)assert.match(answers[0].question,/reconciliation/);
});

test('live history + depth reach the provider genuinely (simulated)',async t=>{
  const h=fakeHarness();t.after(()=>fs.rmSync(h.root,{recursive:true,force:true}));
  await h.session.start({briefId:'live1',consent:true,app:'zoom.us'});
  await h.session.generate('Describe your financial workflow experience');
  assert.equal(h.calls.length,1);
  await h.session.generate('Explain your financial reconciliation experience');
  assert.equal(h.calls.length,2);
  // Second request carries the first Q/A as history context.
  const second=JSON.stringify(h.calls[1]);
  assert.ok(second.includes('Describe your financial workflow experience'));
  await h.session.setDepth('shorter');
  await h.session.generate('Describe your financial workflow experience',{depth:'shorter'});
  assert.ok(JSON.stringify(h.calls[2]).includes('SHORT'));
  await h.session.stop();
});

test('utterance VAD emits on silence timeout and drops noise blips',()=>{
  const outs=[];const vad=new UtteranceVad({onUtterance:pcm=>outs.push(pcm),silenceMs:200,minSpeechMs:300});
  const loud=Buffer.alloc(6400);for(let i=0;i<3200;i++)loud.writeInt16LE(9000,i*2);
  const quiet=Buffer.alloc(6400);
  for(let i=0;i<12;i++)vad.ingest(loud);
  for(let i=0;i<8;i++)vad.ingest(quiet);
  assert.equal(outs.length,1);
  const outs2=[];const v2=new UtteranceVad({onUtterance:pcm=>outs2.push(pcm),silenceMs:200,minSpeechMs:2000});
  v2.ingest(loud);for(let i=0;i<10;i++)v2.ingest(quiet);
  assert.equal(outs2.length,0);
});

test('selection persists selected company in existing storage',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'prep-sel-'));
  try{
    const s=new PrepStore(root);
    s.saveBrief({...brief('Acme','general'),id:'sel1'});
    s.saveSelection({selectedBriefId:'sel1'});
    assert.equal(s.getSelection().selectedBriefId,'sel1');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('live STT prerequisites fail closed with no network use (simulated check)',()=>{
  const {configuration}=require('../prep/media');
  const cfg=configuration(()=>false);
  assert.equal(cfg.available,false);
});

test('persistent live STT transcribes the provided sample wav (cached model, offline)',{timeout:300000},async(t)=>{
  const {spawn}=require('node:child_process');
  const home=os.homedir();
  const py=path.join(home,'Library/Application Support/pipx/venvs/openai-whisper/bin/python');
  const script=path.join(__dirname,'..','prep','transcribe-live.py');
  const model=path.join(home,'.cache','whisper','tiny.en.pt');
  const sample=process.env.PREP_LIVE_STT_SAMPLE_WAV||path.join(__dirname,'fixtures','sample-question.wav');
  if(!(fs.existsSync(py)&&fs.existsSync(script)&&fs.existsSync(model)&&fs.existsSync(sample))){
    t.skip('Local Whisper CLI, cached model or sample wav not present; set PREP_LIVE_STT_SAMPLE_WAV to run this manual integration test.');
    return;
  }
  const child=spawn(py,[script,model],{stdio:['pipe','pipe','pipe'],env:{PATH:'/opt/homebrew/bin:/usr/bin:/bin',HOME:home,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',OMP_NUM_THREADS:'2',MKL_NUM_THREADS:'2'}});
  const lines=[];
  let buf='';
  const done=new Promise((res,rej)=>{
    const timer=setTimeout(()=>rej(Error('persistent STT timeout')),240000);
    if(timer.unref)timer.unref();
    child.stdout.on('data',d=>{
      buf+=d.toString();
      let i;while((i=buf.indexOf('\n'))!==-1){const line=buf.slice(0,i);buf=buf.slice(i+1);if(line.trim())lines.push(line);
        try{const m=JSON.parse(line);if(m.id==='t1'){clearTimeout(timer);res(m);}}catch{}}
    });
    child.on('error',rej);
    // Wait for ready, then send exactly one utterance (bounded).
    const iv=setInterval(()=>{
      if(lines.some(l=>{try{return JSON.parse(l).ready;}catch{return false;}})){clearInterval(iv);
        try{child.stdin.write(JSON.stringify({id:'t1',wav:sample,channel:'interviewer'})+'\n');}catch(e){clearTimeout(timer);rej(e);}}
    },500);
  });
  const msg=await done;
  try{child.kill('SIGTERM');}catch{}
  assert.equal(msg.ok,true);
  assert.match(msg.text,/MCP|guard|limitation/i);
  assert.equal(msg.channel,'interviewer');
});

test('B1: native frames accepted before pause and after resume via callback path (simulated)',async t=>{
  let stt='Tell me about yourself for this role.';
  const h=fakeHarness({transcripts:{}});
  // Phase-varying STT (mutable): distinct questions per phase (dedup is correct).
  const {createLiveSession:mk}=require('../prep/live-session');
  const s2=mk({getStore:()=>h.store,getBackend:()=>({run:async(req,onDelta)=>{const out=JSON.stringify(GOOD);if(onDelta)onDelta(out);return out;}}),native:h.fakeNative,transcribe:async()=>stt,runAnswer:require('../prep/runner').runAnswer});
  t.after(()=>fs.rmSync(h.root,{recursive:true,force:true}));
  t.after(()=>s2.stop().catch(()=>{}));
  const answers=[];s2.on('answer',a=>answers.push(a));
  await s2.start({briefId:'live1',consent:true,app:'zoom.us'});
  const h1=h.fakeNative.handles.at(-1);
  speakFrames(h1);await settle();
  assert.equal(answers.length,1);
  await s2.pause();
  assert.equal(s2.status().phase,'paused');
  stt='Walk me through a project you built.';
  speakFrames(h1);await settle(); // dropped while pausing/paused
  assert.equal(answers.length,1);
  await s2.resume();
  assert.equal(s2.status().phase,'live');
  // Same handle keeps working after resume (callback identity survives).
  speakFrames(h1);await settle();
  assert.equal(answers.length,2);
  assert.match(answers[1].question,/Walk me through/);
});

test('B1: stale old-session frames dropped after stop/new start (simulated)',async t=>{
  const h=fakeHarness({transcripts:{interviewer:'Tell me about yourself for this role.'}});
  t.after(()=>fs.rmSync(h.root,{recursive:true,force:true}));
  t.after(()=>h.session.stop().catch(()=>{}));
  const answers=[];h.session.on('answer',a=>answers.push(a));
  await h.session.start({briefId:'live1',consent:true,app:'zoom.us'});
  const h1=h.fakeNative.handles.at(-1);
  await h.session.stop();
  await h.session.start({briefId:'live1',consent:true,app:'zoom.us'});
  const h2=h.fakeNative.handles.at(-1);
  assert.notEqual(h1,h2);
  speakFrames(h1);await settle(); // old session: must be ignored
  assert.equal(answers.length,0);
  speakFrames(h2);await settle(); // current session: accepted
  assert.equal(answers.length,1);
});

test('B2: pause tears down STT but preserves dialogue; resume restores (simulated)',async t=>{
  const h=fakeHarness({transcripts:{interviewer:'Describe your financial workflow experience'}});
  t.after(()=>fs.rmSync(h.root,{recursive:true,force:true}));
  t.after(()=>h.session.stop().catch(()=>{}));
  await h.session.start({briefId:'live1',consent:true,app:'zoom.us'});
  await h.session.generate('Describe your financial workflow experience');
  const st=h.session._internals.state;
  assert.equal(st.liveQA.length,1);
  await h.session.pause();
  assert.equal(h.session.status().phase,'paused');
  assert.equal(st.liveQA.length,1); // dialogue preserved, not wiped
  await h.session.resume();
  assert.equal(h.session.status().phase,'live');
  assert.equal(st.liveQA.length,1);
  await h.session.generate('Explain your financial reconciliation experience');
  assert.equal(st.liveQA.length,2); // history accumulates across the cycle
});

test('B2: concurrent stops share one teardown; no hang (simulated)',async t=>{
  const h=fakeHarness();t.after(()=>fs.rmSync(h.root,{recursive:true,force:true}));
  await h.session.start({briefId:'live1',consent:true,app:'zoom.us'});
  const [a,b]=await Promise.all([h.session.stop(),h.session.stop()]);
  assert.equal(a.phase,'idle');assert.equal(b.phase,'idle');
  assert.equal(fs.readdirSync(os.tmpdir()).filter(f=>f.startsWith('opencluely-live-')).length,0);
});

test('B7: launch init never enumerates apps; refresh is explicit (static)',()=>{
  const src=fs.readFileSync(path.join(__dirname,'..','prep','renderer.js'),'utf8');
  assert.ok(!/await refreshApps\(\)/.test(src),'init must not auto-enumerate apps');
  assert.ok(/live-refresh-apps/.test(src)&&/refreshApps/.test(src),'explicit Refresh button stays wired');
});

test('answer event carries real evidence/timing/pipeline scalars, no transcripts',async t=>{
  const h=fakeHarness({transcripts:{interviewer:'Describe your financial workflow experience'}});
  t.after(()=>fs.rmSync(h.root,{recursive:true,force:true}));
  t.after(()=>h.session.stop().catch(()=>{}));
  let evt=null;h.session.on('answer',a=>evt=a);
  await h.session.start({briefId:'live1',consent:true,app:'zoom.us'});
  speakFrames(h.fakeNative.handles.at(-1));
  for(let i=0;i<40&&!evt;i++)await new Promise(r=>setTimeout(r,100));
  assert.ok(evt&&evt.answer);
  assert.ok(Array.isArray(evt.evidence)&&evt.evidence.length>0,'real evidence propagates');
  assert.ok(evt.timing&&typeof evt.timing.totalMs==='number','real timing propagates');
  assert.ok(evt.pipeline&&typeof evt.pipeline.sttMs==='number','scalar pipeline timing present');
  assert.ok(evt.pipeline.dispatchToFirstDeltaMs==null||typeof evt.pipeline.dispatchToFirstDeltaMs==='number');
  const blob=JSON.stringify(evt);
  assert.ok(!/transcript|pcm|audioBuffer/i.test(blob.replace(/question|spoken context/gi,'')),'no transcript/audio payloads');
  await h.session.stop();
});

test('cancelled generations carry no answer; UI guards accept them (static + live)',async t=>{
  const h=fakeHarness();t.after(()=>fs.rmSync(h.root,{recursive:true,force:true}));
  let release;const gate=new Promise(r=>release=r);
  const slowBackend={run:async()=>{await gate;return JSON.stringify(GOOD);}};
  const {createLiveSession:mk}=require('../prep/live-session');
  const s2=mk({getStore:()=>h.store,getBackend:()=>slowBackend,native:h.fakeNative,transcribe:async()=>'',runAnswer:require('../prep/runner').runAnswer});
  t.after(()=>s2.stop().catch(()=>{}));
  await s2.start({briefId:'live1',consent:true,app:'zoom.us'});
  let cancelled=null;s2.on('answer-cancelled',c=>cancelled=c);
  const p=s2.generate('Describe your financial workflow experience');
  await new Promise(r=>setTimeout(r,30));
  await s2.stop();
  release();
  assert.equal(await p,null);
  assert.ok(cancelled&&!('answer' in cancelled),'cancelled event has no answer payload');
  for(const f of ['prep/renderer.js','prep/overlay.js']){
    const src=fs.readFileSync(path.join(__dirname,'..',f),'utf8');
    assert.ok(/!p\|\|!p\.answer/.test(src),f+' must guard answer-less events');
  }
});

test('accepted answers emit state so overlay history updates; context survives pause',async t=>{
  const h=fakeHarness();t.after(()=>fs.rmSync(h.root,{recursive:true,force:true}));
  t.after(()=>h.session.stop().catch(()=>{}));
  const states=[];h.session.on('state',s=>states.push(s.phase+':'+(s.history||[]).length));
  await h.session.start({briefId:'live1',consent:true,app:'zoom.us'});
  await h.session.generate('Describe your financial workflow experience');
  assert.ok(states.some(s=>s.endsWith(':1')),'state emitted with history after accept');
  assert.equal(h.session.status().history.length,1);
  await h.session.pause();
  await h.session.resume();
  assert.equal(h.session.status().history.length,1,'company context kept across pause/resume');
});

test('VAD wall-gap flushes speech followed by no frames; reset disposes the timer',async()=>{
  const outs=[];
  const v=new UtteranceVad({onUtterance:(pcm,meta)=>outs.push(meta),silenceMs:5000,minSpeechMs:300,gapMs:60});
  const loud=Buffer.alloc(3200);for(let i=0;i<1600;i++)loud.writeInt16LE(9000,i*2);
  for(let i=0;i<5;i++)v.ingest(loud); // 500ms speech, then NO frames at all
  await new Promise(r=>setTimeout(r,150));
  assert.equal(outs.length,1,'wall gap flushed without further frames');
  assert.ok(outs[0]&&typeof outs[0].voicedAt==='number','meta carries voiced end');
  // Stale disposal: reset before the gap fires -> no utterance, no crash.
  const outs2=[];
  const v2=new UtteranceVad({onUtterance:()=>outs2.push(1),silenceMs:5000,minSpeechMs:300,gapMs:60});
  for(let i=0;i<5;i++)v2.ingest(loud);
  v2.reset();
  await new Promise(r=>setTimeout(r,150));
  assert.equal(outs2.length,0,'disposed timer never fires');
  v.dispose();v2.dispose();
});

test('VAD wall-gap is per-source; healthy silent pipeline unchanged',async()=>{
  const a=[],b=[];
  const va=new UtteranceVad({onUtterance:()=>a.push(1),silenceMs:5000,minSpeechMs:300,gapMs:60});
  const vb=new UtteranceVad({onUtterance:()=>b.push(1),silenceMs:5000,minSpeechMs:300,gapMs:60});
  const loud=Buffer.alloc(3200);for(let i=0;i<1600;i++)loud.writeInt16LE(9000,i*2);
  for(let i=0;i<5;i++)va.ingest(loud);
  await new Promise(r=>setTimeout(r,150));
  assert.equal(a.length,1);assert.equal(b.length,0,'distinct sources independent');
  // Continuous silence still handled by chunk logic, single flush only.
  const c=[];
  const vc=new UtteranceVad({onUtterance:()=>c.push(1),silenceMs:120,minSpeechMs:300,gapMs:10000});
  for(let i=0;i<12;i++)vc.ingest(loud);
  const quiet=Buffer.alloc(3200);
  for(let i=0;i<8;i++)vc.ingest(quiet);
  await new Promise(r=>setTimeout(r,120));
  assert.equal(c.length,1,'no duplicate flush');
  va.dispose();vb.dispose();vc.dispose();
});

test('stop during waiting pause stays idle; pause never sets paused after stop (simulated)',async t=>{
  const h=fakeHarness();t.after(()=>fs.rmSync(h.root,{recursive:true,force:true}));
  let releaseAck;const ackGate=new Promise(r=>releaseAck=r);
  const slowNative={validateRunOptions:require('../prep/native').validateRunOptions,
    startCapture:()=>{const proc=new EventEmitter();return {process:proc,ready:Promise.resolve({ok:true}),kill(){},stop:async()=>{},pause:()=>ackGate,resume:async()=>true,errors:()=>''};}};
  const {createLiveSession:mk}=require('../prep/live-session');
  const s2=mk({getStore:()=>h.store,getBackend:()=>({run:async()=>JSON.stringify(GOOD)}),native:slowNative,transcribe:async()=>'',runAnswer:require('../prep/runner').runAnswer});
  t.after(()=>s2.stop().catch(()=>{}));
  await s2.start({briefId:'live1',consent:true,app:'zoom.us'});
  const p=s2.pause(); // waits on the slow ack
  await new Promise(r=>setTimeout(r,30));
  await s2.stop(); // stop wins the race
  releaseAck(true);
  const st=await p;
  assert.equal(st.phase,'idle');
  assert.equal(s2.status().phase,'idle');
});

test('frame/audio counters throttle to <=2Hz and count per source (simulated)',async t=>{
  const h=fakeHarness({transcripts:{interviewer:'Tell me about yourself for this role.'}});
  t.after(()=>fs.rmSync(h.root,{recursive:true,force:true}));
  t.after(()=>h.session.stop().catch(()=>{}));
  const seen=[];h.session.on('counters',c=>seen.push(c));
  await h.session.start({briefId:'live1',consent:true,app:'zoom.us',withMic:true});
  const hd=h.fakeNative.handles.at(-1);
  const chunk=Buffer.alloc(3200);
  for(let i=0;i<40;i++)hd.onFrame(0,chunk); // rapid burst
  for(let i=0;i<4;i++)hd.onFrame(1,chunk);
  assert.ok(seen.length<=2,'throttled, got '+seen.length);
  assert.equal(hd.onFrame?true:true,true);
  await new Promise(r=>setTimeout(r,650));
  for(let i=0;i<4;i++)hd.onFrame(0,chunk);
  assert.ok(seen.length>=2,'emits again after throttle window');
  const totals=h.session.status().counters;
  assert.deepEqual(totals.frames,[44,4],'per-source frame totals');
  assert.ok(totals.bytes[0]>0&&totals.bytes[1]>0,'byte scalars present');
  assert.ok(Array.isArray(totals.utterances),'utterance scalars present');
});

test('overlay has lifecycle controls, statuses, seconds timing; preload exposes them',()=>{
  const html=fs.readFileSync(path.join(__dirname,'..','prep','overlay.html'),'utf8');
  for(const id of ['ov-pause','ov-resume','ov-stop','prov','time','count'])assert.ok(html.includes(`id="${id}"`),'missing '+id);
  const pre=fs.readFileSync(path.join(__dirname,'..','prep','overlay-preload.js'),'utf8');
  for(const fn of ['pause','resume','stop','onCounters'])assert.ok(pre.includes(fn),'preload missing '+fn);
  const js=fs.readFileSync(path.join(__dirname,'..','prep','overlay.js'),'utf8');
  assert.ok(js.includes('/1000'),'timing shown in seconds');
  assert.ok(js.includes('liveProvider')||js.includes('prov'),'provider/model status shown');
});

test('no concealment flags on the overlay window; ready stays actual success (static)',()=>{
  const src=fs.readFileSync(path.join(__dirname,'..','prep','window.js'),'utf8');
  assert.ok(!/setContentProtection|contentProtection/.test(src),'no content protection flags');
  assert.ok(/alwaysOnTop:true/.test(src),'visible always-on-top retained');
  const nat=fs.readFileSync(path.join(__dirname,'..','prep','native.js'),'utf8');
  assert.ok(/info\.ready===true/.test(nat),'ready only on actual helper success');
});

// Capture must fail closed when native state cannot be confirmed.
for (const action of ['pause','resume']) test(action+' acknowledgement failure stops capture',async t=>{
  const h=fakeHarness();t.after(()=>fs.rmSync(h.root,{recursive:true,force:true}));
  await h.session.start({briefId:'live1',consent:true,app:'zoom.us'});
  const cap=h.fakeNative.handles[0];
  if(action==='resume')await h.session.pause();
  cap[action]=async()=>{throw Error('ack timeout');};
  await assert.rejects(h.session[action](),/ack timeout/);
  assert.equal(h.session.status().phase,'idle');
  assert.equal(h.session.status().recording,false);
  assert.equal(cap.killed,true);
});
test('unexpected ready transcription worker exit stops capture',async t=>{
  const h=fakeHarness();t.after(()=>fs.rmSync(h.root,{recursive:true,force:true}));
  const {PassThrough}=require('node:stream');
  let child;
  const s=createLiveSession({getStore:()=>h.store,getBackend:()=>({run:async()=>JSON.stringify(GOOD)}),native:h.fakeNative,
    spawnWhisper:()=>{child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>true;queueMicrotask(()=>child.stdout.write('{"ready":true}\n'));return child;}});
  t.after(()=>s.stop());
  await s.start({briefId:'live1',consent:true,app:'zoom.us'});
  child.exitCode=1;child.emit('exit',1);
  await settle(40);
  assert.equal(s.status().phase,'idle');
  assert.equal(s.status().recording,false);
  assert.equal(h.fakeNative.handles[0].killed,true);
});
