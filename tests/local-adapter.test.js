'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {geminiToMessages, getBaseUrl, createLocalBackend, attachLocalAdapter} = require('../local/adapter');

test('only loopback URL is accepted', () => {
  assert.equal(getBaseUrl({LOCAL_LLM_URL: 'http://localhost:1234'}), 'http://localhost:1234/v1');
  assert.equal(getBaseUrl({LOCAL_LLM_URL: 'http://127.0.0.1:8080/v1/'}), 'http://127.0.0.1:8080/v1');
  assert.throws(() => getBaseUrl({LOCAL_LLM_URL: 'https://external.example/v1'}));
  assert.throws(() => getBaseUrl({LOCAL_LLM_URL: 'http://10.0.0.5:8080/v1'}));
});

test('Gemini content conversion supports text, context, and screenshots', () => {
  const messages = geminiToMessages({
    systemInstruction: {parts:[{text:'Answer concisely'}]},
    contents: [
      {role:'model', parts:[{text:'Previous answer'}]},
      {role:'user', parts:[{text:'What is this?'}, {inlineData:{mimeType:'image/png',data:'aGVsbG8='}}]}
    ]
  });
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'assistant');
  assert.deepEqual(messages[2].content[1], {type:'image_url', image_url:{url:'data:image/png;base64,aGVsbG8='}});
});

test('local request, stream, vision and service replacement', async (t) => {
  let lastRequest;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({data:[{id:'test-local-model'}]}));
      return;
    }
    if (req.url !== '/v1/chat/completions') {res.writeHead(404);res.end();return;}
    let body = '';
    for await (const c of req) body += c;
    lastRequest = JSON.parse(body);
    if (lastRequest.stream) {
      res.writeHead(200, {'Content-Type':'text/event-stream'});
      res.write('data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"there"}}]}\n\n');
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({choices:[{message:{content:'Local OK'}}]}));
    }
  });
  await new Promise(resolve=> server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve=>server.close(resolve)));
  const env = {LOCAL_LLM_URL:`http://127.0.0.1:${server.address().port}/v1`};
  const backend = createLocalBackend({env});
  const req = {systemInstruction:{parts:[{text:'Help'}]}, contents:[{role:'user',parts:[{text:'test'}]}]};
  assert.equal(await backend.run(req),'Local OK');
  assert.equal(lastRequest.model,'test-local-model');
  assert.equal(lastRequest.stream,false);
  let output = '';
  assert.equal(await backend.run(req, s => output+=s),'Hi there');
  assert.equal(output,'Hi there');
  assert.equal(lastRequest.stream,true);
  const vision = {contents:[{role:'user', parts:[{text:'image?'},{inlineData:{data:'abc',mimeType:'image/jpeg'}}]}]};
  assert.equal(await backend.run(vision),'Local OK');
  assert.equal(lastRequest.messages[0].content[1].type,'image_url');
  const testStatus = await backend.testConnection();
  assert.equal(testStatus.success,true);
  assert.equal(testStatus.model,'test-local-model');

  const fakeService = {isInitialized:false, model:null};
  attachLocalAdapter(fakeService, {env, skipConfig:true});
  assert.equal(fakeService.isInitialized,true);
  assert.equal(await fakeService.executeRequest(req),'Local OK');
  assert.equal((await fakeService.testConnection()).success,true);
});

test('failed requests show errors rather than false successes', async (t)=>{
  const server = http.createServer((_req,res)=>{res.writeHead(503);res.end('model not ready')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const backend = createLocalBackend({env:{LOCAL_LLM_URL:`http://127.0.0.1:${server.address().port}/v1`,LOCAL_LLM_MODEL:'model'}});
  await assert.rejects(backend.run({contents:'Hi'}),/Local AI HTTP 503/);
  assert.equal((await backend.testConnection()).success,false);
});
