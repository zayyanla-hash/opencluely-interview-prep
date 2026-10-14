'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {isQuestionCandidate}=require('../prep/detect');
test('spoken requests are detected without question marks, including the synthetic sample',()=>{
 for(const text of ['Please explain MCP guard in simple terms and state one limitation.','Explain your contribution to the project.','Share an example of handling ambiguity.'])
  assert.equal(isQuestionCandidate(text).isQuestion,true,text);
});
test('embedded descriptions remain statements',()=>{
 for(const text of ['I explained your contribution to the project.','We plan to share an example tomorrow.','Please wait while I explain our process.'])
  assert.equal(isQuestionCandidate(text).isQuestion,false,text);
});
