'use strict';

// Adapt OpenCluely's Gemini-formatted requests to a LOCAL OpenAI-compatible
// /v1/chat/completions server (e.g. llama.cpp or an MLX model server).
// Intentionally only connects to loopback by default. Nothing here starts a
// server, installs a model, or sends data to a cloud API.

function getBaseUrl(env = process.env) {
  const input = (env.LOCAL_LLM_URL || 'http://127.0.0.1:8080/v1').trim();
  const url = new URL(input);
  if (url.protocol !== 'http:') throw new Error('Local AI URL must use http://');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Local AI URL must point to localhost or 127.0.0.1');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid local AI URL');
  const path = url.pathname.replace(/\/+$/, '');
  // Can accept either http://127.0.0.1:8080 or http://127.0.0.1:8080/v1
  if (path !== '' && path !== '/v1') throw new Error('Local AI URL path must be /v1');
  return `${url.origin}/v1`;
}

function plainParts(parts) {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
}

function geminiToMessages(request) {
  const messages = [];
  const system = typeof request.systemInstruction === 'string'
    ? request.systemInstruction
    : plainParts(request.systemInstruction?.parts);
  if (system) messages.push({role: 'system', content: system});
  let contents = request.contents;
  if (typeof contents === 'string') contents = [{role: 'user', parts: [{text: contents}]}];
  if (!Array.isArray(contents)) contents = [];
  for (const item of contents) {
    if (typeof item === 'string') {
      messages.push({role: 'user', content: item});
      continue;
    }
    const role = item.role === 'model' || item.role === 'assistant' ? 'assistant' : 'user';
    const parts = Array.isArray(item.parts) ? item.parts : [];
    const payload = [];
    for (const part of parts) {
      if (typeof part?.text === 'string' && part.text) payload.push({type: 'text', text: part.text});
      if (part?.inlineData?.data) {
        const mime = part.inlineData.mimeType || 'image/png';
        if (!/^image\/(png|jpeg|webp)$/.test(mime)) throw new Error('Unsupported local image MIME type');
        payload.push({type: 'image_url', image_url: {url: `data:${mime};base64,${part.inlineData.data}`}});
      }
    }
    if (payload.length === 0) continue;
    // Most text backends accept strings; vision backends accept multimodal arrays.
    const content = payload.every(p => p.type === 'text')
      ? payload.map(p => p.text).join('\n') : payload;
    messages.push({role, content});
  }
  if (!messages.some(m => m.role === 'user')) throw new Error('No user content in request');
  return messages;
}

function createLocalBackend(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const base = getBaseUrl(env);
  const timeoutMs = Math.min(Math.max(Number(env.LOCAL_LLM_TIMEOUT_MS || 180000), 1000), 600000);
  const configuredModel = (env.LOCAL_LLM_MODEL || '').trim();
  let detectedModel;

  async function requestJson(url, init) {
    const res = await fetchImpl(url, {...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)});
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 900);
      throw new Error(`Local AI HTTP ${res.status}: ${errText}`);
    }
    return res.json();
  }

  async function resolveModel(signal) {
    signal?.throwIfAborted();
    if (configuredModel) return configuredModel;
    if (detectedModel) return detectedModel;
    const models = await requestJson(`${base}/models`, {method: 'GET', signal});
    detectedModel = models?.data?.[0]?.id;
    if (!detectedModel) throw new Error('Local AI server returned no models; set LOCAL_LLM_MODEL');
    return detectedModel;
  }

  async function run(request, onDelta, options = {}) {
    options.signal?.throwIfAborted();
    const model = await resolveModel(options.signal);
    options.signal?.throwIfAborted();
    const generation = request.generationConfig || {};
    const stream = typeof onDelta === 'function';
    const payload = {
      model,
      messages: geminiToMessages(request),
      stream,
      temperature: typeof generation.temperature === 'number' ? generation.temperature : 0.4,
      max_tokens: Math.min(Number(generation.maxOutputTokens || 2048), 8192)
    };
    // Never forward Gemini SDK parameters like thinkingConfig or topK.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
        signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
      });
      if (!res.ok) {
        const errText = (await res.text()).slice(0, 900);
        throw new Error(`Local AI HTTP ${res.status}: ${errText}`);
      }
      if (!stream) {
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
          throw new Error('Local AI returned an empty response');
        }
        return content.trim();
      }
      if (!res.body) throw new Error('Local AI returned no streaming body');
      let full = '';
      let buffer = '';
      let done = false;
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      while (!done) {
        const item = await reader.read();
        if (item.done) break;
        buffer += decoder.decode(item.value, {stream: true});
        // OpenAI SSE framing: events are delimited by double newlines, often CRLF.
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const text = line.slice(5).trim();
            if (text === '[DONE]') { done = true; break; }
            if (!text) continue;
            const parsed = JSON.parse(text);
            const piece = parsed?.choices?.[0]?.delta?.content;
            if (typeof piece === 'string' && piece) {
              full += piece;
              onDelta(piece);
            }
          }
          if (done) break;
        }
      }
      if (typeof reader.cancel === 'function' && done) await reader.cancel().catch(() => {});
      if (!full.trim()) throw new Error('Local AI returned an empty stream');
      return full.trim();
    } finally {
      clearTimeout(timer);
    }
  }

  async function testConnection() {
    const start = Date.now();
    try {
      const model = await resolveModel();
      const response = await run({contents: [{role: 'user', parts: [{text: 'Respond OK.'}]}], generationConfig: {maxOutputTokens: 16}});
      return {success: true, response, model, provider: 'local', latency: Date.now() - start};
    } catch (error) {
      return {success: false, provider: 'local', error: error.message};
    }
  }

  return {run, testConnection, resolveModel};
}

function attachLocalAdapter(service, options = {}) {
  const local = createLocalBackend(options);
  service.isInitialized = true;
  service.model = 'local';
  service.executeRequest = request => local.run(request);
  service.executeAlternativeRequest = request => local.run(request);
  service.executeStreamingRequest = (request, onDelta) => local.run(request, onDelta);
  service.testConnection = () => local.testConnection();
  service.updateApiKey = () => {}; // Gemini settings must not switch a local-only session to cloud.
  // A failed local model call should fail visibly; never return a fabricated answer.
  try {
    const config = require('../src/core/config');
    config.set('llm.gemini.fallbackEnabled', false);
    config.set('llm.gemini.enableFallbackMethod', false);
  } catch (error) {
    if (!options.skipConfig) throw error;
  }
  return service;
}

module.exports = {attachLocalAdapter, createLocalBackend, geminiToMessages, getBaseUrl};
