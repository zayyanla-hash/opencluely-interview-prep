const {contextBridge,ipcRenderer}=require('electron');
const invoke=(name,...args)=>ipcRenderer.invoke('live:'+name,...args);
const on=(name,fn)=>{const wrapped=(_e,x)=>fn(x);ipcRenderer.on('live:'+name,wrapped);return ()=>ipcRenderer.removeListener('live:'+name,wrapped);};
contextBridge.exposeInMainWorld('live',Object.freeze({
  apps:()=>invoke('apps'), start:o=>invoke('start',o), pause:()=>invoke('pause'),
  resume:()=>invoke('resume'), stop:()=>invoke('stop'), status:()=>invoke('status'),
  generate:(q,opts)=>invoke('generate',q,opts), auto:v=>invoke('auto',v), depth:d=>invoke('depth',d),
  importResumeText:id=>invoke('import-resume-text',id),
  onState:fn=>on('state',fn), onTranscript:fn=>on('transcript',fn), onQuestion:fn=>on('question',fn),onQuestionPending:fn=>on('question-pending',fn),
  onAnswer:fn=>on('answer',fn), onDelta:fn=>on('delta',fn), onError:fn=>on('error',fn),
  onCounters:fn=>on('counters',fn),
}));
