'use strict';
const $ = id => document.getElementById(id);
const api = window.prep;

let state, profile, brief = null, editingCard = null;
let currentMode = 'practice'; // 'practice' | 'live'
let secondaryView = null; // null | 'profile' | 'brief' | 'mock' | 'settings' | 'privacy'
let busy = false, practiceQ = '', practiceSaved = false, followUp = '', stream = '', hasImage = false;

const SECONDARY_TITLES = {
  profile: 'Résumé & experience',
  brief: 'Company details',
  mock: 'Practice history & review',
  settings: 'Model & provider',
  privacy: 'Privacy details',
};

const node = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const SCREEN_RECORDING_MESSAGE = "OpenCluely can’t see your apps yet. Turn on Screen & System Audio Recording for the app you launch OpenCluely from (System Settings → Privacy & Security), then press Refresh.";
function cleanError(e) {
  const raw = (e && typeof e === 'object') ? (e.error ?? e.message ?? e) : e;
  let msg = String(raw ?? 'Operation failed.');
  msg = msg.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
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
  return msg || 'Operation failed.';
}
function notice(text = '', error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; }
async function action(fn) { try { return await fn(); } catch (e) { notice(cleanError(e), true); return null; } }
const date = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const secs = ms => (ms == null || !(ms >= 0)) ? 'not received' : (ms / 1000).toFixed(1) + ' s';

// ---------- Mode / secondary view navigation ----------

function renderViews() {
  const showingSecondary = !!secondaryView;
  $('mode-switch').hidden = showingSecondary;
  $('mode-content').hidden = showingSecondary;
  $('secondary-content').hidden = !showingSecondary;
  $('context-line').hidden = showingSecondary;
  for (const m of ['practice', 'live']) {
    const show = !showingSecondary && currentMode === m;
    $('view-' + m).hidden = !show;
  }
  for (const btn of document.querySelectorAll('.mode-btn')) btn.setAttribute('aria-pressed', String(btn.dataset.mode === currentMode));
  for (const v of Object.keys(SECONDARY_TITLES)) $('sec-' + v).hidden = !showingSecondary || secondaryView !== v;
  if (showingSecondary) {
    $('secondary-title').textContent = SECONDARY_TITLES[secondaryView];
    if (secondaryView === 'profile') fillProfile();
  }
  notice();
}
function setMode(m) {
  if (secondaryView) return;
  currentMode = m;
  renderViews();
  $('mode-' + m).focus();
}
let secondaryOpener = null;
function openSecondary(v) {
  if (!SECONDARY_TITLES[v]) return;
  const active = document.activeElement;
  secondaryOpener = (active && active !== document.body) ? active : secondaryOpener;
  closeMoreMenu();
  secondaryView = v;
  renderViews();
  $('secondary-title').focus();
}
function closeSecondary() {
  if (secondaryView === 'profile') writeCard();
  secondaryView = null;
  renderViews();
  const opener = secondaryOpener;
  secondaryOpener = null;
  if (opener && document.contains(opener) && opener.offsetParent !== null) opener.focus();
  else $('more-btn').focus();
}

function menuItems() { return [...$('more-menu').querySelectorAll('.drawer-item')]; }
function closeMoreMenu() {
  const wasOpen = !$('more-menu').hidden;
  $('more-menu').hidden = true;
  $('more-btn').setAttribute('aria-expanded', 'false');
  if (wasOpen) $('more-btn').focus();
}
function toggleMoreMenu() {
  const willOpen = $('more-menu').hidden;
  $('more-menu').hidden = !willOpen;
  $('more-btn').setAttribute('aria-expanded', String(willOpen));
  if (willOpen) menuItems()[0]?.focus();
}
$('more-menu').addEventListener('keydown', e => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = menuItems();
  if (!items.length) return;
  const idx = items.indexOf(document.activeElement);
  const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
  items[next].focus();
});

function context() {
  $('context-company').textContent = brief?.company || 'Add a company to begin';
  $('context-role').textContent = brief ? `${state.roles[brief.role]} · ${brief.date}${brief.interviewer ? ' · ' + brief.interviewer : ''}` : '';
}

function resetAnswer() {
  stream = '';
  $('opening').textContent = 'Your answer will appear here.';
  $('points').replaceChildren();
  $('evidence').replaceChildren();
  $('gaps').textContent = '';
  $('timing').textContent = '';
  $('expansion').textContent = '';
  $('deeper').textContent = '';
  $('answer-state').textContent = 'Ready';
}
function resetPractice() {
  practiceQ = ''; practiceSaved = false; followUp = '';
  $('practice-question').textContent = 'Start a practice question for the selected role.';
  $('practice-answer').value = '';
  $('practice-feedback').replaceChildren();
  $('practice-submit').disabled = true;
  $('practice-follow').disabled = true;
  $('practice-ai').disabled = true;
}

// ---------- Company picker ----------

function renderBriefs() {
  const sel = $('brief-list');
  sel.replaceChildren();
  if (!state.briefs.length) {
    sel.append(node('option', 'Add a company'));
  } else {
    for (const b of state.briefs) {
      const o = node('option', `${b.company || 'Untitled'} — ${state.roles[b.role]}`);
      o.value = b.id;
      sel.append(o);
    }
    if (brief) sel.value = brief.id;
  }
}

$('brief-list').addEventListener('change', () => action(async () => {
  const id = $('brief-list').value;
  if (!id) return newBrief();
  if (busy) throw Error('Stop the response before changing company.');
  brief = await api.getBrief(id);
  await clearAttachment();
  $('question').value = '';
  resetAnswer(); resetPractice(); fillBrief(); context(); renderBriefs();
}));

async function newBrief() {
  if (busy) return notice('Stop the response before changing company.', true);
  brief = { id: crypto.randomUUID(), company: '', role: 'startup', date: date(), jobDescription: '', notes: '', hypotheses: '', interviewer: '', resume: '', history: [] };
  await clearAttachment();
  $('question').value = '';
  resetAnswer(); resetPractice(); fillBrief(); context(); renderBriefs();
  openSecondary('brief');
  $('brief-company').focus();
}

function fillBrief() {
  if (!brief) return;
  for (const [field, id] of Object.entries({ company: 'brief-company', role: 'brief-role', date: 'brief-date', interviewer: 'brief-interviewer', jobDescription: 'brief-jd', notes: 'brief-notes', hypotheses: 'brief-hypotheses', resume: 'brief-resume' })) $(id).value = brief[field];
}
async function saveBrief() {
  if (!brief) await newBrief();
  const b = { ...brief };
  for (const [field, id] of Object.entries({ company: 'brief-company', role: 'brief-role', date: 'brief-date', interviewer: 'brief-interviewer', jobDescription: 'brief-jd', notes: 'brief-notes', hypotheses: 'brief-hypotheses', resume: 'brief-resume' })) b[field] = $(id).value;
  if (!b.company.trim()) throw Error('Enter a company name.');
  brief = await api.saveBrief(b);
  state.briefs = (await api.state()).briefs;
  context(); renderBriefs();
  notice('Company brief saved locally.');
  return brief;
}

// ---------- Profile / experience cards ----------

function writeCard() {
  if (!editingCard) return;
  const c = profile.cards.find(x => x.id === editingCard);
  if (!c) return;
  for (const field of ['problem', 'user', 'contribution', 'collaborators', 'approach', 'limitations']) {
    const el = $('card-' + field);
    if (el) c[field] = el.value;
  }
  const lines = id => ($(id)?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
  c.verifiedFacts = lines('card-facts');
  c.unverifiedClaims = lines('card-claims');
  c.questions = lines('card-questions');
  const e = c.evidence[0] || { id: c.id + ':user', kind: 'candidate statement' };
  e.label = $('evidence-label').value; e.url = $('evidence-url').value; e.excerpt = $('evidence-excerpt').value;
  c.evidence = [e, ...c.evidence.slice(1)];
}
function fillCard(id) {
  editingCard = id;
  const c = profile.cards.find(x => x.id === id);
  const root = $('card-fields');
  root.replaceChildren();
  for (const [field, label] of Object.entries({ problem: 'Problem', user: 'Intended user', contribution: 'My personal contribution', collaborators: 'Collaborators and AI tools', approach: 'Implementation approach', limitations: 'Limitations / missing evidence' })) {
    const l = node('label', label, field === 'limitations' ? 'full' : '');
    const t = node('textarea'); t.id = 'card-' + field; t.rows = 3; t.maxLength = 1800; t.value = c[field];
    l.append(t); root.append(l);
  }
  $('card-facts').value = c.verifiedFacts.join('\n');
  $('card-claims').value = c.unverifiedClaims.join('\n');
  $('card-questions').value = c.questions.join('\n');
  const e = c.evidence[0] || {};
  $('evidence-label').value = e.label || ''; $('evidence-url').value = e.url || ''; $('evidence-excerpt').value = e.excerpt || '';
  $('profile-json').value = JSON.stringify(profile, null, 2);
}
function fillProfile() {
  if (!profile) return;
  $('identity-name').value = profile.identity.name;
  $('identity-location').value = profile.identity.location;
  $('availability').value = profile.preferences.availability;
  $('degree').value = profile.identity.completedBachelors === null ? 'unknown' : (profile.identity.completedBachelors ? 'yes' : 'no');
  $('education').value = profile.identity.educationDetail || '';
  $('skill-boundary').value = profile.preferences.skills;
  const selected = (editingCard && profile.cards.some(c => c.id === editingCard)) ? editingCard : profile.cards[0].id;
  $('card-picker').replaceChildren(...profile.cards.map(c => { const o = node('option', c.name); o.value = c.id; return o; }));
  $('card-picker').value = selected;
  fillCard(selected);
}
async function saveProfile() {
  writeCard();
  profile.identity.name = $('identity-name').value;
  profile.identity.location = $('identity-location').value;
  profile.identity.completedBachelors = $('degree').value === 'unknown' ? null : ($('degree').value === 'yes');
  profile.identity.educationDetail = $('education').value;
  profile.preferences.availability = $('availability').value;
  profile.preferences.skills = $('skill-boundary').value;
  profile = await api.saveProfile(profile);
  $('profile-json').value = JSON.stringify(profile, null, 2);
  notice('Profile saved. Unverified claims remain excluded from factual grounding.');
}

// ---------- Provider / model (Settings) ----------

async function refreshProvider() {
  const p = await api.providerStatus();
  $('provider-status').textContent = p.connected ? `Connected${p.model ? ' · ' + p.model : ''}` : p.error;
  $('provider-status').title = p.error || '';
  if (p.connected) {
    $('conn-indicator').hidden = false;
    $('conn-text').textContent = `ChatGPT connected${p.model ? ' · ' + p.model : ''}`;
    $('account').hidden = true;
  } else {
    $('conn-indicator').hidden = true;
    $('account').hidden = false;
  }
  const modelSel = $('model-select');
  modelSel.replaceChildren(node('option', 'Default'));
  if (Array.isArray(p.models) && p.models.length) {
    for (const m of p.models) { const o = node('option', m.name || m.slug); o.value = m.slug; modelSel.append(o); }
    modelSel.value = p.model || '';
  }
  return p;
}

// ---------- Answer rendering ----------

function showResult(r) {
  const a = r.answer;
  $('opening').textContent = a.opening;
  $('points').replaceChildren(...a.points.slice(0, 3).map(x => node('li', x)));
  $('expansion').textContent = a.expansion || '';
  $('deeper').textContent = a.deeper || '';
  $('expansion-wrap').hidden = !a.expansion;
  $('deeper-wrap').hidden = !a.deeper;
  $('gaps').textContent = a.gaps.length ? 'Evidence gaps\n' + a.gaps.map(x => '• ' + x).join('\n') : '';
  if (r.timing.providerRequest) {
    $('timing').textContent = `First words ${secs(r.timing.firstTokenMs)} · Full answer ${secs(r.timing.totalMs)}`;
  } else {
    $('timing').textContent = 'Answered from supplied profile facts. No model request.';
  }
  const sourceIds = new Set(a.claims.flatMap(c => c.sources));
  const sources = sourceIds.size ? r.evidence.filter(e => sourceIds.has(e.id)) : r.evidence;
  $('evidence').replaceChildren();
  for (const e of sources) {
    const box = node('div', undefined, 'evidence-source');
    box.append(node('b', e.card || e.label), node('span', e.label), node('p', e.excerpt));
    const claims = a.claims.filter(c => c.sources.includes(e.id));
    for (const c of claims) box.append(node('p', 'Supports: ' + c.text));
    if (e.url) { const b = node('button', 'Open source ↗'); b.addEventListener('click', () => action(() => api.source(e.url))); box.append(b); }
    $('evidence').append(box);
  }
}
function showPracticeResult(r) {
  const a = r.answer;
  const root = $('practice-feedback');
  root.replaceChildren(node('h2', a.opening), ...a.points.slice(0, 3).map(x => node('p', x)));
  if (a.expansion) root.append(node('h2', 'Grounded expansion / cheat sheet'), node('p', a.expansion));
  if (a.deeper) root.append(node('h2', 'Follow-up'), node('p', a.deeper));
  if (a.gaps.length) root.append(node('h2', 'Weak stories / evidence gaps'), node('p', a.gaps.join('\n')));
}

function setBusy(v) {
  busy = v;
  $('pick-image').disabled = v;
  $('import-audio').disabled = v || !state.fileTranscription;
  $('remove-image').disabled = v;
  $('cancel').disabled = !v;
  $('practice-cancel').disabled = !v;
  $('answer-run').disabled = v;
  $('provider').disabled = v;
  for (const id of ['practice-ai', 'practice-submit', 'practice-review', 'practice-start', 'brief-save', 'profile-save']) {
    $(id).disabled = v || (id === 'practice-submit' && (!practiceQ || practiceSaved)) || (id === 'practice-ai' && !practiceSaved);
  }
  if (v) $('answer-state').textContent = 'Writing…';
}

async function run(mode = 'answer') {
  if (busy) return;
  if (!brief || !state.briefs.some(b => b.id === brief.id)) return notice('Save a company brief first.', true);
  const question = mode === 'answer' ? $('question').value : (mode === 'critique' ? practiceQ : 'Review this company’s practice answers and prepare three improvements, weak stories and a compact cheat sheet.');
  if (mode === 'review' && !brief.history.length) return notice('Complete a practice answer first.', true);
  notice();
  setBusy(true);
  stream = '';
  try {
    const r = await api.run({ briefId: brief.id, question, mode, answer: mode === 'critique' ? $('practice-answer').value : '', live: false, consent: false, image: mode === 'answer' && hasImage });
    if (mode === 'answer') { showResult(r); $('answer-state').textContent = 'Done'; }
    else { showPracticeResult(r); notice('Open the Practice tab to inspect source evidence and measured timing.'); }
  } catch (e) {
    if (mode === 'answer') resetAnswer();
    if (/abort|cancel/i.test(cleanError(e))) { $('answer-state').textContent = 'Stopped'; notice('Stopped.'); }
    else { $('answer-state').textContent = 'Error'; notice(cleanError(e), true); }
  } finally { setBusy(false); }
}

async function clearAttachment() {
  await api.clearImage();
  hasImage = false;
  $('image-preview').removeAttribute('src');
  $('image-preview-wrap').hidden = true;
  $('media-status').textContent = 'Nothing is recorded or captured.';
}

// ---------- Event wiring: top bar / navigation ----------

$('new-brief').addEventListener('click', () => action(newBrief));
$('edit-brief').addEventListener('click', () => brief ? openSecondary('brief') : newBrief());
$('more-btn').addEventListener('click', toggleMoreMenu);
$('more-close').addEventListener('click', closeMoreMenu);
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => openSecondary(b.dataset.view));
for (const b of document.querySelectorAll('.back-btn')) b.addEventListener('click', closeSecondary);
for (const b of document.querySelectorAll('.mode-btn')) b.addEventListener('click', () => setMode(b.dataset.mode));
$('mode-switch').addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (secondaryView) return;
  e.preventDefault();
  setMode(currentMode === 'practice' ? 'live' : 'practice');
});
$('open-mock').addEventListener('click', () => openSecondary('mock'));
$('account').addEventListener('click', () => action(() => api.account()));

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('more-menu').hidden) { closeMoreMenu(); return; }
  if ((e.key === 'Enter') && (e.metaKey || e.ctrlKey) && currentMode === 'practice' && !secondaryView) { e.preventDefault(); run(); }
});
document.addEventListener('click', e => {
  if (!$('more-menu').hidden && !$('more-menu').contains(e.target) && e.target !== $('more-btn')) closeMoreMenu();
});

// ---------- Practice mode wiring ----------

$('pick-image').addEventListener('click', () => action(async () => {
  const image = await api.pickImage();
  if (!image) return;
  hasImage = true;
  $('image-preview').src = image.preview;
  $('image-name').textContent = image.name;
  $('image-preview-wrap').hidden = false;
  $('media-status').textContent = 'Image attached. It will be sent when you submit the question.';
}));
$('remove-image').addEventListener('click', () => action(clearAttachment));
$('import-audio').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true); $('answer-state').textContent = 'Transcribing file…';
  notice('Transcribing selected file on this Mac. No microphone or GPT upload.');
  try {
    const result = await api.importAudio();
    if (result) {
      $('question').value = result.text;
      notice(`Transcribed ${result.name} locally with ${result.model}. Review the text, then click Get answer.`);
      $('media-status').textContent = 'Reviewed transcript only goes to GPT when submitted.';
      $('answer-state').textContent = 'Transcript ready';
    } else notice('No audio file selected.');
  } catch (e) {
    notice(/abort|cancel/i.test(cleanError(e)) ? 'File transcription stopped.' : cleanError(e), true);
  } finally { setBusy(false); }
});
api.onDelta(d => {
  stream += d;
  const opening = stream.match(/"opening"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (opening) {
    let text = opening[1];
    try { text = JSON.parse('"' + text + '"'); } catch { }
    $('opening').textContent = text;
    $('answer-state').textContent = 'Writing…';
  }
});
$('answer-run').addEventListener('click', () => run());
$('cancel').addEventListener('click', () => action(() => api.cancel()));

// ---------- Live assistance mode wiring ----------

const liveApi = window.live;
let liveState = null;
let liveHasRun = false;
let lastMainPhase = null;
const LIVE_STATE_LABEL = { idle: 'NOT STARTED', starting: 'STARTING…', live: 'LIVE', pausing: 'PAUSING…', paused: 'PAUSED', resuming: 'RESUMING…' };
const MEETING_APP_PRIORITY = ['us.zoom.xos', 'com.microsoft.teams2', 'com.microsoft.teams', 'com.google.Chrome', 'com.apple.Safari', 'company.thebrowser.Browser', 'com.tinyspeck.slackmacgap', 'com.apple.FaceTime', 'com.apple.QuickTimePlayerX'];

function describeAudioScope(s) {
  if (s.phase === 'idle') return 'Not listening';
  const scope = s.scope || s.app || '';
  const m = /audio for (.+?) \(/.exec(scope);
  if (m) return `Listening to ${m[1]} only`;
  return 'Listening to all system audio';
}
function updateStartButton() {
  const on = !!liveState && ['live', 'paused', 'starting', 'pausing', 'resuming'].includes(liveState.phase);
  $('live-start').disabled = on || !$('live-capture-consent').checked;
}
function displayLive(s) {
  liveState = s;
  const on = s.phase === 'live' || s.phase === 'paused' || s.phase === 'starting' || s.phase === 'pausing' || s.phase === 'resuming';
  if (s.phase === 'live') liveHasRun = true;
  if (s.phase === 'idle' && lastMainPhase && lastMainPhase !== 'idle' && liveHasRun) $('live-capture-consent').checked = false;
  lastMainPhase = s.phase;
  $('live-state').textContent = s.phase === 'idle' ? (liveHasRun ? 'STOPPED' : 'NOT STARTED') : (LIVE_STATE_LABEL[s.phase] || 'NOT STARTED');
  updateStartButton();
  $('live-pause').disabled = s.phase !== 'live';
  $('live-resume').disabled = s.phase !== 'paused';
  $('live-stop').disabled = !on;
  $('live-status').textContent = `${describeAudioScope(s)} · Mic ${s.withMic ? 'on' : 'off'}`;
}
$('live-capture-consent').addEventListener('change', updateStartButton);
function filterAndSortApps(apps) {
  const seen = new Set();
  const list = [];
  for (const a of apps || []) {
    const name = a && a.name;
    const bundleID = a && a.bundleID;
    if (!name || !bundleID) continue;
    if (bundleID.includes('.xpc.')) continue;
    if (/Service$|Agent$/.test(bundleID)) continue;
    if (bundleID === 'com.apple.WindowManager') continue;
    if (seen.has(bundleID)) continue;
    seen.add(bundleID);
    list.push({ name, bundleID });
  }
  list.sort((x, y) => {
    const rx = MEETING_APP_PRIORITY.includes(x.bundleID) ? MEETING_APP_PRIORITY.indexOf(x.bundleID) : MEETING_APP_PRIORITY.length;
    const ry = MEETING_APP_PRIORITY.includes(y.bundleID) ? MEETING_APP_PRIORITY.indexOf(y.bundleID) : MEETING_APP_PRIORITY.length;
    return rx !== ry ? rx - ry : x.name.localeCompare(y.name);
  });
  return list;
}
async function refreshApps() {
  try {
    const apps = await liveApi.apps();
    const sel = $('live-app'); const cur = sel.value;
    const list = filterAndSortApps(apps).slice(0, 60);
    sel.replaceChildren(...[{ value: '', name: 'Select an app…' }].concat(list.map(a => ({ value: a.bundleID, name: a.name }))).map(o => { const el = document.createElement('option'); el.value = o.value; el.textContent = o.name; return el; }));
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  } catch (e) {
    notice('Application list unavailable. Grant Screen Recording permission; system-audio fallback remains: ' + cleanError(e), true);
  }
}
$('live-refresh-apps').addEventListener('click', () => action(refreshApps));
$('live-start').addEventListener('click', () => action(async () => {
  if (!brief) throw Error('Save a company brief first.');
  const useSystem = !$('live-app').value && $('live-system').checked;
  displayLive(await liveApi.start({ briefId: brief.id, app: $('live-app').value, allowSystem: useSystem, withMic: $('live-mic').checked, consent: $('live-capture-consent').checked, autoMode: $('live-auto').checked }));
  notice('Live assistance started. Nothing was recorded until this moment.');
}));
$('live-pause').addEventListener('click', () => action(async () => displayLive(await liveApi.pause())));
$('live-resume').addEventListener('click', () => action(async () => displayLive(await liveApi.resume())));
$('live-stop').addEventListener('click', () => action(async () => { displayLive(await liveApi.stop()); notice('Live assistance stopped. Temporary audio deleted.'); }));
$('live-manual').addEventListener('click', () => action(async () => {
  const q = $('live-manual-question').value.trim();
  if (!q) throw Error('Type a question first.');
  await liveApi.generate(q);
}));
$('live-auto').addEventListener('change', e => action(async () => displayLive(await liveApi.auto(e.target.checked))));
liveApi.onState(displayLive);
liveApi.onQuestion(({ auto }) => notice(auto ? 'Auto-detected question sent to the live window.' : 'Question sent to the live window.'));
liveApi.onQuestionPending(() => notice('Manual mode: question retained in the live window.'));
liveApi.onAnswer(p => { if (!p||!p.answer) { notice('Live response stopped.'); return; } notice('Live draft ready in the live window.'); });
liveApi.onError(e => notice(cleanError(e), true));

$('brief-resume-import').addEventListener('click', () => action(async () => {
  if (!brief) throw Error('Save a company brief first.');
  const r = await api.importResumeText(brief.id);
  brief = await api.getBrief(brief.id);
  fillBrief();
  notice('Resume text imported (' + r.chars + ' chars). It stays unverified until supported by evidence.');
}));

// ---------- Secondary view wiring ----------

$('brief-save').addEventListener('click', () => action(saveBrief));
$('brief-delete').addEventListener('click', () => action(async () => {
  if (!brief) return;
  if (!confirm(`Permanently delete the ${brief.company || 'untitled'} brief and its practice history?`)) return;
  await api.deleteBrief(brief.id);
  brief = null;
  state.briefs = (await api.state()).briefs;
  resetAnswer(); resetPractice(); context(); renderBriefs();
  notice('Company context deleted locally.');
}));
$('profile-save').addEventListener('click', () => action(saveProfile));
$('card-picker').addEventListener('change', e => { writeCard(); fillCard(e.target.value); });
$('profile-json-apply').addEventListener('click', () => action(async () => {
  const p = JSON.parse($('profile-json').value);
  profile = await api.saveProfile(p);
  editingCard = null; fillProfile();
  notice('JSON applied and saved.');
}));
$('profile-reset').addEventListener('click', () => action(async () => {
  if (!confirm('Permanently remove profile edits and restore the supplied facts?')) return;
  profile = await api.resetProfile();
  editingCard = null; fillProfile();
  notice('Profile reset. Company briefs were kept.');
}));
$('provider').addEventListener('change', () => action(async () => {
  const p = await api.provider($('provider').value);
  state.provider = p.provider;
  await refreshProvider();
  notice(`Selected ${p.provider === 'chatgpt' ? 'ChatGPT subscription' : 'configured local server'}.`);
}));
$('refresh-provider').addEventListener('click', () => action(refreshProvider));
$('model-select').addEventListener('change', () => action(async () => {
  const m = $('model-select').value;
  if (!m) return;
  await api.model(m);
  await refreshProvider();
}));

$('practice-start').addEventListener('click', () => action(async () => {
  if (!brief || !state.briefs.some(b => b.id === brief.id)) throw Error('Save a company brief first.');
  if (practiceQ && !practiceSaved) throw Error('Answer the current question before moving on.');
  practiceQ = await api.practiceQuestion(brief.id);
  practiceSaved = false;
  $('practice-question').textContent = practiceQ;
  $('practice-answer').value = '';
  $('practice-submit').disabled = false; $('practice-ai').disabled = true; $('practice-follow').disabled = true;
}));
$('practice-submit').addEventListener('click', () => action(async () => {
  if (!practiceQ || practiceSaved) throw Error('Start a new question before saving another answer.');
  const feedback = await api.savePractice({ briefId: brief.id, question: practiceQ, answer: $('practice-answer').value });
  brief = await api.getBrief(brief.id);
  practiceSaved = true; followUp = feedback.followUp;
  $('practice-feedback').replaceChildren(node('h2', 'Three improvements'), node('p', feedback.specificity), node('p', feedback.relevance), node('p', feedback.clarity), ...feedback.unsupportedClaims.map(x => node('p', x, 'gaps')), node('h2', 'Follow-up'), node('p', feedback.followUp));
  $('practice-submit').disabled = true; $('practice-ai').disabled = false; $('practice-follow').disabled = false;
}));
$('practice-follow').addEventListener('click', () => {
  if (!practiceSaved) return;
  practiceQ = followUp; practiceSaved = false;
  $('practice-question').textContent = practiceQ;
  $('practice-answer').value = '';
  $('practice-submit').disabled = false; $('practice-ai').disabled = true; $('practice-follow').disabled = true;
});
$('practice-ai').addEventListener('click', () => run('critique'));
$('practice-review').addEventListener('click', () => run('review'));
$('practice-cancel').addEventListener('click', () => action(() => api.cancel()));
$('clear-practice').addEventListener('click', () => action(async () => {
  if (!brief) return;
  if (!confirm('Permanently delete practice history for this company?')) return;
  await api.clearPractice(brief.id);
  brief = await api.getBrief(brief.id);
  resetPractice();
  notice('Practice history deleted.');
}));

// ---------- Boot ----------

(async () => {
  state = await api.state();
  try { displayLive(state.live || { phase: 'idle' }); } catch (e) { }
  profile = state.profile;
  for (const [id, title] of Object.entries(state.roles)) { const o = node('option', title); o.value = id; $('brief-role').append(o); }
  $('provider').value = state.provider;
  $('import-audio').disabled = !state.fileTranscription;
  if (state.selectedBriefId && state.briefs.some(b => b.id === state.selectedBriefId)) brief = await api.getBrief(state.selectedBriefId);
  else if (state.briefs.length) brief = await api.getBrief(state.briefs[0].id);
  if (brief) fillBrief();
  context(); renderBriefs(); fillProfile();
  await refreshProvider();
  renderViews();
})().catch(e => notice(cleanError(e), true));
