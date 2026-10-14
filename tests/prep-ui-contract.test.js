'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '../prep/index.html');
const overlayHtmlPath = path.join(__dirname, '../prep/overlay.html');
const rendererPath = path.join(__dirname, '../prep/renderer.js');
const overlayJsPath = path.join(__dirname, '../prep/overlay.js');

function ids(html) { return [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]); }
function dollarIds(js) { return [...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]); }

test('prep controls have unique identifiers, including distinct live capture consent', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const list = ids(html);
  assert.equal(new Set(list).size, list.length, 'Duplicate IDs make a visible control operate the wrong field');
  assert.ok(list.includes('live-capture-consent'));
});

test('renderer loads with the immutable globals exposed by Electron contextBridge', () => {
  const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {}, classList: { toggle() {} }, setAttribute() {}, value: '', style: {} }), querySelectorAll: () => [], addEventListener() {} } });
  context.window = context;
  const api = new Proxy({ state: () => new Promise(() => {}) }, { get: (target, key) => target[key] || (() => {}) });
  Object.defineProperty(context, 'prep', { value: api, configurable: false, writable: false });
  Object.defineProperty(context, 'live', { value: api, configurable: false, writable: false });
  context.crypto = { randomUUID: () => '00000000-0000-0000-0000-000000000000' };
  const script = fs.readFileSync(rendererPath, 'utf8');
  assert.doesNotThrow(() => vm.runInContext(script, context));
});

test('cleanError strips remote-method prefixes, unwraps JSON, and never leaks JSON braces', () => {
  const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {}, classList: { toggle() {} }, setAttribute() {}, value: '', style: {} }), querySelectorAll: () => [], addEventListener() {} } });
  context.window = context;
  const api = new Proxy({ state: () => new Promise(() => {}) }, { get: (target, key) => target[key] || (() => {}) });
  Object.defineProperty(context, 'prep', { value: api, configurable: false, writable: false });
  Object.defineProperty(context, 'live', { value: api, configurable: false, writable: false });
  context.crypto = { randomUUID: () => '00000000-0000-0000-0000-000000000000' };
  const script = fs.readFileSync(rendererPath, 'utf8');
  vm.runInContext(script, context);
  const cleanError = vm.runInContext('cleanError', context);

  assert.equal(cleanError({ message: "Error invoking remote method 'prep:run': Error: Something broke." }), 'Something broke.');

  const tccMessage = 'Error invoking remote method \'live:apps\': Error: {"ok":false,"error":"Could not enumerate applications (The user declined TCCs for this binary.)"}';
  const friendly = cleanError({ message: tccMessage });
  assert.match(friendly, /Turn on Screen & System Audio Recording/);
  assert.ok(!/[{}]/.test(friendly), 'friendly message must not contain JSON braces');

  assert.equal(cleanError({ message: '{"ok":false,"message":"Totally fine explanation"}' }), 'Totally fine explanation');

  const noFieldJson = cleanError({ message: '{"weird": "shape without error field"}' });
  assert.ok(!/[{}]/.test(noFieldJson), 'cleanError must never leak raw JSON braces to the user');
});

test('overlay loads with the immutable globals exposed by Electron contextBridge', () => {
  const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {}, textContent: '', hidden: false, replaceChildren() {}, checked: false, value: '' }), querySelectorAll: () => [] } });
  context.window = context;
  const api = new Proxy({ status: () => Promise.resolve({ phase: 'idle' }) }, { get: (target, key) => target[key] || (() => Promise.resolve({})) });
  Object.defineProperty(context, 'live', { value: api, configurable: false, writable: false });
  const script = fs.readFileSync(overlayJsPath, 'utf8');
  assert.doesNotThrow(() => vm.runInContext(script, context));
});

test('cleanLiveError reads the answer-error object shape instead of printing [object Object]', () => {
  const context = vm.createContext({ document: { getElementById: () => ({ addEventListener() {}, textContent: '', hidden: false, replaceChildren() {}, checked: false, value: '', classList: { toggle() {}, remove() {} } }), querySelectorAll: () => [] } });
  context.window = context;
  const api = new Proxy({ status: () => new Promise(() => {}) }, { get: (target, key) => target[key] || (() => Promise.resolve({})) });
  Object.defineProperty(context, 'live', { value: api, configurable: false, writable: false });
  const script = fs.readFileSync(overlayJsPath, 'utf8');
  vm.runInContext(script, context);
  const cleanLiveError = vm.runInContext('cleanLiveError', context);

  const result = cleanLiveError({ seq: 1, question: 'q', error: 'Response not accepted: X' });
  assert.ok(result.includes('X'), 'cleanLiveError should surface the underlying reason: ' + result);
  assert.ok(!result.includes('[object Object]'), 'cleanLiveError must never print [object Object]: ' + result);
});

test('every $(id) referenced in renderer.js exists in prep/index.html', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const htmlIds = new Set(ids(html));
  const js = fs.readFileSync(rendererPath, 'utf8');
  const missing = dollarIds(js).filter(id => !htmlIds.has(id));
  assert.deepEqual(missing, [], 'renderer.js references ids missing from prep/index.html: ' + missing.join(', '));
});

test('every $(id) referenced in overlay.js exists in prep/overlay.html', () => {
  const html = fs.readFileSync(overlayHtmlPath, 'utf8');
  const htmlIds = new Set(ids(html));
  const js = fs.readFileSync(overlayJsPath, 'utf8');
  const missing = dollarIds(js).filter(id => !htmlIds.has(id));
  assert.deepEqual(missing, [], 'overlay.js references ids missing from prep/overlay.html: ' + missing.join(', '));
});

test('overlay.html has unique identifiers', () => {
  const html = fs.readFileSync(overlayHtmlPath, 'utf8');
  const list = ids(html);
  assert.equal(new Set(list).size, list.length, 'Duplicate IDs make a visible control operate the wrong field');
});

test('legacy microphone box is removed from prep/index.html', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  for (const legacyId of ['audio-indicator', 'audio-info', 'audio-consent', 'audio-start', 'audio-stop']) {
    assert.ok(!html.includes(`id="${legacyId}"`), `legacy control ${legacyId} should be removed`);
  }
});

test('prep/index.html has only one consent checkbox', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const checkboxes = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*id="([^"]+)"[^>]*>/g)].map(m => m[1]);
  const consentBoxes = checkboxes.filter(id => /consent/i.test(id));
  assert.deepEqual(consentBoxes, ['live-capture-consent'], 'exactly one consent checkbox should remain');
});

test('overlay text never claims "verified" as a statement of truth', () => {
  const html = fs.readFileSync(overlayHtmlPath, 'utf8');
  const js = fs.readFileSync(overlayJsPath, 'utf8');
  assert.ok(!/\bverified\b/i.test(html), 'overlay.html must not claim an answer is "verified"');
  // the JS may read a `verified` field off the IPC payload, but must not render that word as UI text
  const uiStrings = [...js.matchAll(/'([^']*)'/g), ...js.matchAll(/"([^"]*)"/g)].map(m => m[1]);
  for (const s of uiStrings) assert.ok(!/\bverified\b/i.test(s), 'overlay.js must not render the word "verified" in UI text: ' + s);
});

test('window.js never enables content protection or screen-capture concealment', () => {
  const windowJsPath = path.join(__dirname, '../prep/window.js');
  const js = fs.readFileSync(windowJsPath, 'utf8');
  assert.ok(!/setContentProtection/.test(js), 'window.js must not call setContentProtection');
});

test('no inline style or script attributes, consistent with the strict CSP', () => {
  for (const file of [htmlPath, overlayHtmlPath]) {
    const html = fs.readFileSync(file, 'utf8');
    assert.ok(!/\sstyle="/.test(html), file + ' must not use inline style attributes');
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), file + ' must not use inline scripts');
  }
});
