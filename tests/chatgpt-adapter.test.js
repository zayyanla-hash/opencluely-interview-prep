'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {convertRequest,createChatGPTBackend,attachChatGPTAdapter}=require('../auth/chatgpt-adapter');

test('converts Gemini text and history to supported ChatGPT messages',()=>{
  const x=convertRequest({
    systemInstruction:{parts:[{text:'System rules'}]},
    contents:[{role:'user',parts:[{text:'Earlier question'}]},{role:'model',parts:[{text:'Earlier answer'}]},{role:'user',parts:[{text:'New question'}]}],
  });
  assert.equal(x.instructions,'System rules');
  assert.deepEqual(x.input,[
    {role:'user',content:'Earlier question'},
    {role:'assistant',content:'Earlier answer'},
    {role:'user',content:'New question'},
  ]);
});

test('supports screenshot-only or mixed image/text inputs without copying credentials',()=>{
  const x=convertRequest({contents:[{role:'user',parts:[{text:'What is this?'},{inlineData:{mimeType:'image/png',data:'aGVsbG8='}}]}]});
  assert.deepEqual(x.input[0].content,[{type:'input_text',text:'What is this?'},{type:'input_image',image_url:'data:image/png;base64,aGVsbG8='}]);
  assert.throws(()=>convertRequest({contents:[{role:'user',parts:[{inlineData:{mimeType:'application/pdf',data:'YWJj'}}]}]}),/Unsupported image/);
  assert.throws(()=>convertRequest({contents:[{role:'user',parts:[{inlineData:{mimeType:'image/png',data:'inval!d='}}]}]}),/Unsupported image/);
});

test('streams text through selected account model and reports connection status',async()=>{
  let last;
  const bridge={chooseModel:async()=> 'gpt-selected',call:async(method,payload,onDelta)=>{
    last={method,payload};if(onDelta) {onDelta('Streaming ');onDelta('success');return 'Streaming success';}return 'Connected';
  }};
  const backend=createChatGPTBackend(bridge);
  let output='';
  const result=await backend.run({contents:[{role:'user',parts:[{text:'Help'}]}]},s=>output+=s);
  assert.equal(result,'Streaming success');assert.equal(output,'Streaming success');
  assert.equal(last.payload.model,'gpt-selected');
  const fake={isInitialized:false};
  attachChatGPTAdapter(fake,{bridge,skipConfig:true});
  assert.equal(fake.isInitialized,true);
  assert.equal(fake.model,'chatgpt');
  assert.equal(await fake.executeRequest({contents:[{role:'user',parts:[{text:'Help'}]}]}),'Connected');
  assert.equal((await fake.testConnection()).success,true);
});

test('does not return a fabricated answer if ChatGPT rejects a request',async()=>{
  const backend=createChatGPTBackend({chooseModel:async()=> 'gpt',call:async()=>{throw Error('usage limit exceeded')}});
  await assert.rejects(backend.run({contents:[{role:'user',parts:[{text:'Hi'}]}]}),/usage limit/);
});
