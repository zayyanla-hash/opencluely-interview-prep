'use strict';
const {app, safeStorage, shell} = require('electron');
const {join} = require('node:path');
const fs = require('node:fs');
const {URL} = require('node:url');
const {WorkerRPC} = require('./rpc-parent');

const preferencesFile = () => join(app.getPath('userData'), 'siwc-preferences.json');
let worker;
function handlePrivilegedOperation(method, payload) {
  if (!app.isReady()) throw new Error('Electron not ready for OS credential storage');
  const available = safeStorage.isEncryptionAvailable();
  switch (method) {
    case 'encryption-available': return available;
    case 'encrypt': {
      if (!available || typeof payload.plaintext !== 'string') throw new Error('OS credential encryption unavailable');
      return safeStorage.encryptString(payload.plaintext).toString('base64');
    }
    case 'decrypt': {
      if (!available || typeof payload.ciphertext !== 'string') throw new Error('OS credential decryption unavailable');
      return safeStorage.decryptString(Buffer.from(payload.ciphertext, 'base64'));
    }
    case 'open-browser': {
      const target = new URL(payload.url);
      if (target.origin !== 'https://auth.openai.com') throw new Error('Unexpected ChatGPT authorization destination: ' + target.origin);
      return shell.openExternal(target.href).then(() => true);
    }
    default: throw new Error('Unrecognized privileged operation');
  }
}
function getWorker() {
  if (!worker) {
    const nodeBin = process.env.SIWC_NODE_BIN || (fs.existsSync('/opt/homebrew/bin/node') ? '/opt/homebrew/bin/node' : 'node');
    worker = new WorkerRPC({
      binary: nodeBin,
      script: join(__dirname, 'siwc-sidecar.mjs').replace(/app\.asar([/\\])/, 'app.asar.unpacked$1'),
      onParentRequest: handlePrivilegedOperation,
    });
    app.once('before-quit', () => worker?.close());
  }
  return worker;
}
const call = (method, payload, onDelta, timeout, signal) => getWorker().call(method, payload, onDelta, timeout, signal);
function getPreference() {
  try {
    const data = JSON.parse(fs.readFileSync(preferencesFile(), 'utf8'));
    return typeof data.model === 'string' ? data.model : '';
  } catch {return '';}
}
function setPreference(model) {
  if (typeof model !== 'string' || !/^[A-Za-z0-9_.:/-]{1,120}$/.test(model)) throw new Error('Invalid ChatGPT model selection');
  const file = preferencesFile();
  fs.mkdirSync(join(file, '..'), {recursive:true});
  fs.writeFileSync(file, JSON.stringify({model}, null, 2), {mode:0o600});
  fs.chmodSync(file, 0o600);
}
async function chooseModel(signal) {
  signal?.throwIfAborted();
  const session = await call('getSession', {}, null, 60000, signal);
  if (!session.sharing) throw new Error('Connect your ChatGPT account and allow plan usage before sending requests.');
  const models = await call('listModels', {}, null, 60000, signal);
  const configured = getPreference();
  const selected = models.find(m => m.slug === configured) || models[0];
  if (!selected) throw new Error('No models are available under the connected ChatGPT account.');
  return selected.slug;
}
async function getState() {
  const session = await call('getSession');
  const profiles = await call('listProfiles');
  let models = [];
  let modelError;
  if (session.sharing) {
    try {models = await call('listModels');} catch(e) {modelError=e.message;}
  }
  const model = models.find(m => m.slug === getPreference())?.slug || models[0]?.slug || '';
  return {session, profiles, models, model, modelError, encryptionAvailable:safeStorage.isEncryptionAvailable()};
}
module.exports = {call, chooseModel, getState, getPreference, setPreference};
