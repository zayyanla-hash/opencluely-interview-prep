// Personal, local Sign in with ChatGPT worker. Runs under system Node 22+, NOT
// Electron's bundled Node. The official @siwc/local SDK owns all OAuth tokens.
// Only line-delimited request/response messages travel over private stdio pipes.
import readline from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createChatGPT } from '@siwc/local';

let nextParentId = 0;
const pendingParent = new Map();
const inFlight = new Map();
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function requestParent(method, payload = {}) {
  const id = ++nextParentId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingParent.delete(id);
      reject(new Error(`${method} timed out in the main process`));
    }, method === 'open-browser' ? 30000 : 15000);
    pendingParent.set(id, { resolve, reject, timer });
    out({kind: 'parent-request', id, method, payload});
  });
}

const credentialEncryption = {
  id: 'electron-safe-storage-v1',
  isAvailable: async () => Boolean(await requestParent('encryption-available')),
  encrypt: async (plaintext) => Buffer.from(await requestParent('encrypt', {plaintext}), 'base64'),
  decrypt: async (ciphertext) => String(await requestParent('decrypt', {ciphertext: Buffer.from(ciphertext).toString('base64')})),
};

const chatgpt = createChatGPT({
  appName: 'OpenCluely Personal',
  appId: 'opencluely-personal',
  redirectPort: 0,
  sendHostId: true,
  storageDir: join(homedir(), '.config', 'opencluely-personal', 'chatgpt'),
  credentialEncryption,
  openBrowser: async (url) => requestParent('open-browser', {url}),
});

async function handle(method, payload, id) {
  switch (method) {
    case 'getSession': return chatgpt.getSession();
    case 'listProfiles': return chatgpt.listProfiles();
    case 'listModels': return chatgpt.listModels();
    case 'signIn': return chatgpt.signIn(payload?.newProfile ? {newProfile: true} : payload?.reconsent ? {reconsent: true} : {});
    case 'cancelSignIn': chatgpt.cancelSignIn(); return true;
    case 'disconnect': await chatgpt.disconnect(); return chatgpt.getSession();
    case 'selectProfile': {
      if (typeof payload?.id !== 'string' || payload.id.length > 100) throw new Error('Invalid connection ID');
      return chatgpt.selectProfile(payload.id);
    }
    case 'run': {
      const session = await chatgpt.getSession();
      if (!session.sharing) throw new Error('Sign in with ChatGPT and authorize ChatGPT plan usage first.');
      const model = payload?.model || (await chatgpt.listModels())[0]?.slug;
      if (!model) throw new Error('No available ChatGPT models for this account.');
      const controller = new AbortController();
      inFlight.set(id, controller);
      try {
        const result = await chatgpt.streamResponse({
          model,
          input: payload.input,
          ...(typeof payload.instructions === 'string' && payload.instructions ? {instructions: payload.instructions} : {}),
          signal: controller.signal,
          onDelta: delta => {if (delta) out({kind:'stream', id, delta});},
        });
        return result.text;
      } finally { inFlight.delete(id); }
    }
    case 'cancel': {
      const taskId = payload?.taskId;
      if (inFlight.has(taskId)) inFlight.get(taskId).abort();
      return true;
    }
    default: throw new Error('Unsupported ChatGPT worker operation');
  }
}

readline.createInterface({input: process.stdin, crlfDelay: Infinity}).on('line', async line => {
  let message;
  try {message = JSON.parse(line);} catch {return;}
  if (message?.kind === 'parent-response') {
    const waiter = pendingParent.get(message.id);
    if (!waiter) return;
    pendingParent.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(message.error || 'Parent process error'));
    return;
  }
  if (message?.kind !== 'call' || !Number.isInteger(message.id)) return;
  try {
    const result = await handle(message.method, message.payload || {}, message.id);
    out({kind:'result', id:message.id, ok:true, result});
  } catch (error) {
    // Do not print credentials, raw response bodies, or user inputs.
    const messageText = error instanceof Error ? error.message.slice(0, 500) : 'ChatGPT worker request failed';
    out({kind:'result', id:message.id, ok:false, error:messageText});
  }
});
process.stdin.on('end', () => process.exit(0));
