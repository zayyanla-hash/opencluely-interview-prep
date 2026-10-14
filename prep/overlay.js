'use strict';
const $ = id => document.getElementById(id), api = window.live;
let raw = '', qAt = 0, visibleMs = null;
let hasQuestion = false, hasLiveRun = false, lastPhase = null;
const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
const SCREEN_RECORDING_MESSAGE = "OpenCluely can’t see your apps yet. Turn on Screen & System Audio Recording for the app you launch OpenCluely from (System Settings → Privacy & Security), then press Refresh.";
function cleanLiveError(e) {
  const raw = (e && typeof e === 'object') ? (e.error ?? e.message ?? e) : e;
  let msg = String(raw ?? 'Live error');
  msg = msg.replace(/^Error invoking remote method \x27[^\x27]+\x27: (?:Error: )?/, '');
  const trimmed = msg.trim();
  if (/^[{[]/.test(trimmed)) {
    let extracted = null;
    try {
      const parsed = JSON.parse(trimmed);
      extracted = parsed && (parsed.error || parsed.message);
    } catch {
      const m = trimmed.match(/\x22(?:error|message)\x22\s*:\s*\x22((?:[^\x22\\]|\\.)*)\x22/);
      if (m) extracted = m[1].replace(/\\(.)/g, '$1');
    }
    if (extracted) msg = String(extracted);
  }
  if (/TCC|Screen Recording|declined/i.test(msg)) return SCREEN_RECORDING_MESSAGE;
  msg = msg.replace(/[{}]/g, '').trim();
  return (msg || 'Live error').slice(0, 400);
}
const err = t => { $('err').textContent = t || ''; };
const hideAnsStatus = () => { const el = $('ans-status'); el.hidden = true; el.textContent = ''; el.classList.remove('badge-passed', 'badge-draft'); };
const setAnsStatus = (text, passed) => { const el = $('ans-status'); el.hidden = false; el.textContent = text; el.classList.toggle('badge-passed', !!passed); el.classList.toggle('badge-draft', !passed); };
const secs = ms => (ms == null || !(ms >= 0)) ? 'not received' : (ms/1000).toFixed(1) + ' s';

const STATE_LABEL = { idle: 'NOT STARTED', starting: 'STARTING…', live: 'LIVE', pausing: 'PAUSING…', paused: 'PAUSED', resuming: 'RESUMING…' };

function audioChipText(s) {
  if (s.phase === 'idle') return 'Not listening';
  const scope = s.scope || s.app || '';
  const m = /audio for (.+?) \(/.exec(scope);
  if (m) return `${m[1]} only`;
  return 'All system audio';
}
function micChipText(s) { return s.phase === 'idle' ? 'Mic off' : `Mic ${s.withMic ? 'on' : 'off'}`; }

function resetAnswerArea() {
  $('opening').textContent = 'Your answer will appear here.';
  $('pts').replaceChildren();
  $('evidence').replaceChildren();
  $('time').textContent = '';
  hideAnsStatus();
  $('ans-note').hidden = true;
}
function applyEmptyState(phase) {
  $('q').textContent = phase === 'idle'
    ? (hasLiveRun ? 'Session stopped. Nothing is being captured.' : 'Start live assistance from the main window.')
    : 'Listening… ask a question out loud, or type one below.';
  $('qmeta').textContent = '';
  resetAnswerArea();
  hasQuestion = false;
}

function renderState(s) {
  if (!s.lastError) err('');
  if (s.phase === 'live') hasLiveRun = true;
  if (s.phase === 'idle' && lastPhase !== null && lastPhase !== 'idle') hasQuestion = false;
  if (!hasQuestion) applyEmptyState(s.phase);
  lastPhase = s.phase;
  $('ov-state').textContent = s.phase === 'idle' ? (hasLiveRun ? 'STOPPED' : 'NOT STARTED') : (STATE_LABEL[s.phase] || 'NOT STARTED');
  $('ov-state').classList.toggle('is-live', s.phase === 'live');
  $('ov-audio').textContent = audioChipText(s);
  $('ov-mic').textContent = micChipText(s);
  const lp = s.liveProvider || {};
  $('prov').textContent = (lp.provider || lp.model) ? `${lp.provider || '?'} · ${lp.model || 'model pending'}` : '';
  $('autom').checked = !!s.autoMode;
  $('ov-pause').hidden = s.phase !== 'live';
  $('ov-pause').disabled = s.phase !== 'live';
  $('ov-resume').hidden = s.phase !== 'paused';
  $('ov-resume').disabled = s.phase !== 'paused';
  $('ov-stop').disabled = s.phase === 'idle';
  const h = $('hist'); h.replaceChildren(...(s.history || []).slice().reverse().map(x => { const li = document.createElement('li'); li.textContent = x.question; return li; }));
}
api.onState(renderState);
api.onQuestion(({ question, auto }) => {
  $('q').textContent = question;
  $('qmeta').textContent = auto ? 'auto-detected · drafting…' : 'manual · drafting…';
  hasQuestion = true;
  raw = ''; qAt = Date.now(); visibleMs = null;
  $('time').textContent = '';
  setAnsStatus('Draft — still writing', false);
  $('ans-note').hidden = true;
  $('opening').textContent = 'Receiving draft…';
  $('pts').replaceChildren();
  $('evidence').replaceChildren();
});
api.onQuestionPending(({ question }) => { $('q').textContent = question; $('qmeta').textContent = 'manual mode · retained, no provider called'; hasQuestion = true; });
api.onDelta(({ delta }) => { raw += String(delta || ''); renderStream(); });
api.onAnswer(p => {
  if (!p||!p.answer) { $('qmeta').textContent = 'Response stopped.'; resetAnswerArea(); return; }
  const { answer } = p;
  $('opening').textContent = answer.opening;
  $('pts').replaceChildren(...answer.points.slice(0, 3).map(x => { const li = document.createElement('li'); li.textContent = x; return li; }));
  const t = p.timing || {};
  const pieces = [`Heard → first words ${secs(p.pipeline ? p.pipeline.voicedToFirstDeltaMs : t.firstTokenMs)}`, `Full answer ${secs(p.pipeline ? p.pipeline.voicedToAcceptedMs : t.totalMs)}`];
  if (p.pipeline) pieces.push(`Transcription ${secs(p.pipeline.sttMs)}`);
  $('time').textContent = pieces.join(' · ');
  if (p.verified) { setAnsStatus('Passed app checks', true); $('ans-note').hidden = false; }
  else { setAnsStatus('Draft — not checked', false); $('ans-note').hidden = true; }
  $('qmeta').textContent = (p.auto === false ? 'manual' : 'auto') + ' · drafted';
  renderEvidence(p);
  err('');
});
function renderEvidence(p) {
  const root = $('evidence'); root.replaceChildren();
  const a = p.answer; const evidence = p.evidence || [];
  const sourceIds = new Set((a.claims || []).flatMap(c => c.sources));
  const sources = sourceIds.size ? evidence.filter(e => sourceIds.has(e.id)) : evidence;
  for (const e of sources) {
    const box = node('div', undefined, 'evidence-source');
    box.append(node('b', e.card || e.label), node('span', e.label), node('p', e.excerpt));
    root.append(box);
  }
}
api.onTranscript(t => {
  if (!t) return;
  if (t.channel === 'mic') { $('qmeta').textContent = 'mic context noted (never auto-answered)'; }
  else if (t.raw) { $('q').textContent = t.text; $('qmeta').textContent = 'interviewer transcript (unverified)'; hasQuestion = true; }
});
api.onCounters(c => {
  if (!c) return;
  const kb = i => Math.round((c.bytes[i] || 0) / 1024) + 'kB';
  $('count').textContent = `frames ${c.frames[0] || 0}/${c.frames[1] || 0} · audio ${kb(0)}/${kb(1)} · utterances ${c.utterances ? c.utterances[0] || 0 : 0}/${c.utterances ? c.utterances[1] || 0 : 0}`;
});
function reportAnswerRejection(e) {
  const reason = cleanLiveError(e);
  $('ans-note').hidden = true;
  // Only the app's own answer checks produce "not accepted"; anything else is a request failure.
  if (/not accepted/i.test(reason)) {
    setAnsStatus('Draft — not checked', false);
    $('qmeta').textContent = 'not accepted';
    err(`The app’s checks didn’t accept this draft (${reason.replace(/^Response not accepted:\s*/i, '')}). Use it with care or press Regenerate.`);
  } else {
    if (raw) setAnsStatus('Draft — not checked', false); else $('ans-status').hidden = true;
    $('qmeta').textContent = 'failed';
    err(`Couldn’t get an answer (${reason}). Press Regenerate to try again.`);
  }
}
api.onError(e => {
  if (e && typeof e === 'object' && 'seq' in e && 'question' in e) { reportAnswerRejection(e); return; }
  err(cleanLiveError(e));
});
$('ov-pause').addEventListener('click', async () => { try { await api.pause(); } catch (e) { err(cleanLiveError(e)); } });
$('ov-resume').addEventListener('click', async () => { try { await api.resume(); } catch (e) { err(cleanLiveError(e)); } });
$('ov-stop').addEventListener('click', async () => { try { await api.stop(); } catch (e) { err(cleanLiveError(e)); } });
function renderStream() {
  let opening = '', points = [];
  const om = raw.match(/"opening"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (om) { try { opening = JSON.parse('"' + om[1] + '"'); } catch { opening = om[1]; } }
  const pm = raw.match(/"points"\s*:\s*\[((?:[^\]\\]|\\.)*)/);
  if (pm) { const items = pm[1].match(/"((?:[^"\\]|\\.)*)"/g) || []; points = items.map(s => { try { return JSON.parse(s); } catch { return s; } }).slice(0, 3); }
  const hasPoint = opening || points.length > 0;
  if (hasPoint && visibleMs == null && qAt) visibleMs = Date.now() - qAt;
  $('opening').textContent = opening || 'Receiving draft…';
  $('pts').replaceChildren(...points.map(p => { const li = document.createElement('li'); li.textContent = p; return li; }));
  setAnsStatus('Draft — still writing', false);
  $('ans-note').hidden = true;
  $('qmeta').textContent = 'streaming';
}
$('regen').addEventListener('click', async () => { err(''); if (!hasQuestion) return err('No question to regenerate.'); try { await api.generate($('q').textContent); } catch (e) { reportAnswerRejection(e); } });
$('shorter').addEventListener('click', async () => { err(''); if (!hasQuestion) return err('No question to shorten.'); try { await api.depth('shorter'); await api.generate($('q').textContent, { depth: 'shorter' }); } catch (e) { reportAnswerRejection(e); } });
$('deeper').addEventListener('click', async () => { err(''); if (!hasQuestion) return err('No question to expand.'); try { await api.depth('deeper'); await api.generate($('q').textContent, { depth: 'deeper' }); } catch (e) { reportAnswerRejection(e); } });
$('gen').addEventListener('click', async () => { err(''); const q = $('manual').value.trim(); if (!q) return err('Type a question first.'); try { await api.generate(q); } catch (e) { reportAnswerRejection(e); } });
$('manual').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('gen').click(); } });
$('autom').addEventListener('change', async e => { try { await api.auto(e.target.checked); } catch (er) { err(cleanLiveError(er)); } });
api.status().then(renderState).catch(e => err(cleanLiveError(e)));
