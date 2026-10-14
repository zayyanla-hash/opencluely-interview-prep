'use strict';
// Converts OpenCluely's Gemini-shaped prompts into the official SIWC DevKit
// input format. OAuth access tokens never enter this adapter or its renderer.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MIME_TYPES = new Set(['image/jpeg','image/png','image/webp','image/gif']);

function convertRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('Invalid AI request');
  const instructions = Array.isArray(request.systemInstruction?.parts)
    ? request.systemInstruction.parts.map(p=>p.text || '').filter(Boolean).join('\n') : '';
  const items = [];
  const contents = typeof request.contents === 'string'
    ? [{role:'user',parts:[{text:request.contents}]}] : request.contents;
  if (!Array.isArray(contents)) throw new Error('No AI conversation messages provided');
  for (const item of contents) {
    const role = item.role === 'model' ? 'assistant' : item.role === 'user' ? 'user' : null;
    if (!role || !Array.isArray(item.parts)) continue;
    const content = [];
    for (const p of item.parts) {
      if (typeof p.text === 'string' && p.text) content.push({type:'input_text',text:p.text});
      if (p.inlineData) {
        if (role !== 'user') throw new Error('Images are supported only in user messages');
        const mime = p.inlineData.mimeType;
        const data = p.inlineData.data;
        if (!MIME_TYPES.has(mime) || typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) {
          throw new Error('Unsupported image format');
        }
        if (!data || Buffer.byteLength(data, 'base64') > MAX_IMAGE_BYTES) throw new Error('Image exceeds 10 MB limit');
        content.push({type:'input_image', image_url:`data:${mime};base64,${data}`});
      }
    }
    if (!content.length) continue;
    if (role === 'assistant') {
      // Prior assistant messages are text-only in this adapter.
      items.push({role, content:content.filter(p=>p.type==='input_text').map(p=>p.text).join('\n')});
    } else if (content.some(p=>p.type==='input_image')) {
      items.push({role,content});
    } else {
      items.push({role,content:content.map(p=>p.text).join('\n')});
    }
  }
  if (!items.some(p=>p.role==='user')) throw new Error('AI request requires at least one user message');
  return {input:items, ...(instructions ? {instructions} : {})};
}

function createChatGPTBackend(bridge) {
  async function run(request, onDelta, options = {}) {
    options.signal?.throwIfAborted();
    const payload = convertRequest(request);
    const model = await bridge.chooseModel(options.signal);
    options.signal?.throwIfAborted();
    const result = await bridge.call('run', {model,...payload}, onDelta, 240000, options.signal);
    if (typeof result !== 'string' || !result.trim()) throw new Error('ChatGPT returned no completed response');
    return result.trim();
  }
  async function testConnection() {
    try {
      const model = await bridge.chooseModel();
      const result = await bridge.call('run', {model,input:[{role:'user',content:'Reply exactly OK.'}]},null,60000);
      if (!result?.trim()) throw new Error('ChatGPT returned an empty response');
      return {success:true,provider:'chatgpt',model,response:result};
    } catch (error) {
      return {success:false,provider:'chatgpt',error:error.message};
    }
  }
  return {run,testConnection};
}

function attachChatGPTAdapter(service, options = {}) {
  const bridge = options.bridge || require('./electron-bridge');
  const backend = createChatGPTBackend(bridge);
  service.isInitialized = true;
  service.model = 'chatgpt';
  service.executeRequest = request => backend.run(request);
  service.executeAlternativeRequest = request => backend.run(request);
  service.executeStreamingRequest = (request,onDelta) => backend.run(request,onDelta);
  service.testConnection = backend.testConnection;
  service.updateApiKey = () => {};
  // Never silently route requests to Gemini or return fabricated offline answers.
  if (!options.skipConfig) {
    const config = require('../src/core/config');
    config.set('llm.gemini.fallbackEnabled',false);
    config.set('llm.gemini.enableFallbackMethod',false);
    config.set('stealth.hideFromDock',false);
    config.set('stealth.disguiseProcess',false);
  }
  return service;
}
module.exports = {convertRequest,createChatGPTBackend,attachChatGPTAdapter};
