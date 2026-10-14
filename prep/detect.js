'use strict';
// Automatic interviewer-question detection: contextual triggers, not punctuation.
// Feed interviewer source to auto-answer; mic is context only.
// - Triggers must open the utterance (after fillers) or follow a sentence
//   boundary; embedded clauses ("I explained how we would...") are rejected.
// - Rejects ordinary statements. Dedups identical/overlapping STT with expiry;
//   accumulates partial utterances with an evaluated flush callback.
const LEAD_FILLER=/^(?:(?:please|so|well|um+|uh+|right|okay|ok|and|but|now|actually|anyway)[,.\s]+)+/i;
const TRIGGER_PATTERNS=[
  /\bexplain\b/i, /\bshare (?:a|an|your)\b/i,
  /\btell me about\b/i, /\bwalk me through\b/i, /\bdescribe a time\b/i, /\bdescribe (a|your|an)\b/i,
  /\bgive me an example\b/i, /\bhow (do|did|would|have|can|could|should)\b/i,
  /\bwhat (do|did|would|have|was|were|is|are|would|could|should|motivated|interests)\b/i,
  /\bwhy (do|did|would|are|is|should)\b/i, /\bwould you\b/i, /\bcould you\b/i,
  /\bcan you (describe|explain|walk|tell|share)\b/i, /\bwhat would you prioritize\b/i,
  /\bhow would you (improve|approach|handle|prioritize|think)\b/i,
  /\bwhat is your\b/i, /\bdo you have experience\b/i, /\bhave you (ever|worked|built|led|handled)\b/i,
];
const QUESTION_WORD=/\b(how|what|why|when|where|which|who|whose|would|could|can|do|does|did|is|are|was|were|have|tell|walk|describe|explain|share)\b/i;
function normalize(s){return String(s||'').replace(/\s+/g,' ').trim();}
function wordOverlap(a,b){
  const sa=new Set(a.toLowerCase().split(/\s+/).filter(w=>w.length>2));
  const sb=new Set(b.toLowerCase().split(/\s+/).filter(w=>w.length>2));
  if(!sa.size||!sb.size)return 0;
  let inter=0;for(const w of sa)if(sb.has(w))inter++;
  return inter/Math.max(sa.size,sb.size);
}
function stripFillers(t){let prev;do{prev=t;t=t.replace(LEAD_FILLER,'');}while(t!==prev);return t;}
// Returns {isQuestion, reason}. A trigger counts only at the start of the
// utterance (after fillers) or right after a sentence boundary; otherwise an
// embedded clause such as "I explained how we would migrate" is a statement.
function isQuestionCandidate(text){
  const t=normalize(text);
  if(t.split(/\s+/).filter(Boolean).length<4||t.length<18)return {isQuestion:false,reason:'too-short'};
  const endsQ=/\?\s*$/.test(t);
  const stripped=stripFillers(t);
  for(const rx of TRIGGER_PATTERNS){
    const m=rx.exec(stripped);
    if(!m)continue;
    const before=stripped.slice(0,m.index);
    // At the start, or immediately after sentence-ending punctuation.
    if(!before.trim()||/[.?!…]\s*$/.test(before))return {isQuestion:true,reason:'trigger'};
    // A trailing "?" promotes a trigger that follows a clause boundary.
    if(endsQ&&before.trim())return {isQuestion:true,reason:'trigger-after-boundary'};
  }
  if(endsQ){
    const head=stripFillers(t);
    // Question form only when the utterance OPENS with a question word/clause.
    if(/^(how|what|why|when|where|which|who|whose|would|could|can|do|does|did|is|are|was|were|have|tell|walk|describe|explain|share)\b/i.test(head)&&head.split(/\s+/).length>=5)
      return {isQuestion:true,reason:'question-form'};
  }
  return {isQuestion:false,reason:'statement'};
}
// Dedup: identical or heavily overlapping recent STT is not a new question.
// recent entries are {text, at}; entries older than maxAgeMs are forgotten so
// an intentional repeat later is allowed.
function isDuplicate(candidate,recent,threshold=0.82,maxAgeMs=5*60*1000,now=Date.now()){
  const t=normalize(candidate).toLowerCase();
  const list=recent.map(r=>typeof r==='string'?{text:r,at:0}:(r||{text:'',at:0}));
  for(const r of list){
    if(r.at&&now-r.at>maxAgeMs)continue;
    const n=normalize(r.text).toLowerCase();
    if(!n)continue;
    if(n===t)return true;
    if(t.includes(n)&&n.length>20)return true;
    if(n.includes(t)&&t.length>20)return true;
    if(wordOverlap(t,n)>=threshold)return true;
  }
  return false;
}
// Accumulate partial utterances: fragments ending without terminal punctuation
// are buffered (bounded). The flush callback MUST evaluate the flushed text
// (it receives it); without a supplied callback the buffer is returned on the
// next push's result so text is never silently dropped.
function createAccumulator({maxChars=600,flushMs=4000}={}){
  let buf='',timer=null;
  const clear=()=>{if(timer){clearTimeout(timer);timer=null;}};
  return {
    push(fragment,onFlush){
      fragment=normalize(fragment);
      if(!fragment)return {buffered:true,text:''};
      const endsTerminal=/[.?!\u2026]\s*$/.test(fragment);
      buf=normalize([buf,fragment].filter(Boolean).join(' ')).slice(-maxChars);
      clear();
      if(endsTerminal||buf.length>=maxChars){const out=buf;buf='';return {buffered:false,text:out};}
      timer=setTimeout(()=>{
        const out=buf;buf='';timer=null;
        try{onFlush&&onFlush(out);}catch{}
      },flushMs);
      if(timer.unref)timer.unref();
      return {buffered:true,text:buf};
    },
    flush(){const out=buf;buf='';clear();return out;},
    peek(){return buf;},
    cancel(){buf='';clear();},
  };
}
module.exports={isQuestionCandidate,isDuplicate,createAccumulator,normalize,wordOverlap,TRIGGER_PATTERNS};
