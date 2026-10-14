'use strict';
const {spawn} = require('node:child_process');
const readline = require('node:readline');

// Electron's main process owns this worker; no network listener exposes its RPC.
class WorkerRPC {
  constructor({binary, script, onParentRequest, spawnFn = spawn}) {
    this.binary = binary;
    this.script = script;
    this.onParentRequest = onParentRequest;
    this.spawnFn = spawnFn;
    this.child = null;
    this.pending = new Map();
    this.nextId = 0;
  }
  start() {
    if (this.child) return;
    const child = this.spawnFn(this.binary, [this.script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: (()=> {const e = {...process.env, NODE_ENV:'production'}; delete e.OPENAI_API_KEY; delete e.CODEX_API_KEY; for (const k of Object.keys(e)) if (/(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/.test(k) || /^(OPENAI_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$)/.test(k)) delete e[k]; return e;})(),
    });
    this.child = child;
    readline.createInterface({input: child.stdout, crlfDelay: Infinity}).on('line', line => this.handleLine(line));
    // Do not echo stderr: third-party log lines can contain private request text.
    child.stderr?.resume();
    child.on('error', error => this.failAll(`Could not start the ChatGPT worker: ${error.code || error.message}`));
    child.on('exit', (code) => this.failAll(`ChatGPT worker stopped (${code ?? 'unknown'}).`));
  }
  failAll(message) {
    for (const {reject, timer, cleanup} of this.pending.values()) {clearTimeout(timer); cleanup?.(); reject(new Error(message));}
    this.pending.clear();
    this.child = null;
  }
  send(message) {
    if (!this.child?.stdin?.writable) throw new Error('ChatGPT worker is unavailable.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  async handleLine(line) {
    let message;
    try {message = JSON.parse(line);} catch {return;}
    if (message?.kind === 'parent-request' && Number.isInteger(message.id)) {
      try {
        const result = await this.onParentRequest(message.method, message.payload || {});
        this.send({kind:'parent-response', id:message.id, ok:true, result});
      } catch (error) {
        this.send({kind:'parent-response', id:message.id, ok:false, error:error?.message?.slice(0,300) || 'Operation unavailable'});
      }
      return;
    }
    const entry = this.pending.get(message?.id);
    if (!entry) return;
    if (message.kind === 'stream') {
      if (typeof message.delta === 'string') entry.onDelta?.(message.delta);
      return;
    }
    if (message.kind === 'result') {
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.cleanup?.();
      message.ok ? entry.resolve(message.result) : entry.reject(new Error(message.error || 'ChatGPT operation failed'));
    }
  }
  call(method, payload = {}, onDelta, timeout = 240_000, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    try {this.start();} catch (e) {return Promise.reject(e);}
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener('abort', cancel);
      const cancel = () => {
        this.pending.delete(id); clearTimeout(timer); cleanup();
        if (method === 'run') {try {this.send({kind:'call',id:++this.nextId,method:'cancel',payload:{taskId:id}});} catch {}}
        reject(signal?.aborted ? signal.reason : new Error(`${method} timed out`));
      };
      const timer = setTimeout(cancel, timeout);
      this.pending.set(id, {resolve,reject,timer,onDelta,cleanup});
      signal?.addEventListener('abort',cancel,{once:true});
      try {this.send({kind:'call',id,method,payload});}
      catch (error) {clearTimeout(timer);cleanup();this.pending.delete(id);reject(error);}
    });
  }
  close() {
    if (this.child) {this.child.kill(); this.child = null;}
    this.failAll('ChatGPT worker closed.');
  }
}
module.exports = {WorkerRPC};
