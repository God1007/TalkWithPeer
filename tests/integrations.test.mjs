import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {cursorModels,resolveModel} from '../server/catalog.mjs';
import {parsePetLink,inspectSprite} from '../server/pets.mjs';
import {discoverA2A,A2AAdapter} from '../server/a2a-adapter.mjs';
import sharp from 'sharp';

test('model effort is resolved to a real Cursor catalog entry',()=>{
  const models=cursorModels('opus-low - Opus Low\nopus-high - Opus High\nunrelated prose');
  assert.equal(resolveModel({kind:'cursor',models},{model:'opus-low',parameters:{effort:'high'}}).model,'opus-high');
  assert.throws(()=>resolveModel({kind:'cursor',models},{model:'opus-low',parameters:{effort:'max'}}));
});
test('Codex links validate format and disallow hidden destinations',()=>{
  const result=parsePetLink('codex://pets/install?name=Cat&imageUrl=https%3A%2F%2Fexample.com%2Fcat.webp&spriteVersionNumber=2');
  assert.equal(result.version,2);assert.equal(result.name,'Cat');
  assert.throws(()=>parsePetLink('codex://pets/install?name=Cat&imageUrl=file%3A%2F%2Fetc%2Fpasswd'));
  assert.throws(()=>parsePetLink('codex://pets/install?name=Cat&imageUrl=https%3A%2F%2Fexample.com%2Fcat.png&spriteVersionNumber=7'));
});
test('sprite validation checks decoded dimensions, alpha and visible frames',async()=>{
  const bytes=await sharp({create:{width:1536,height:1872,channels:4,background:{r:100,g:120,b:140,alpha:0.5}}}).png().toBuffer();
  const sprite=await inspectSprite(bytes,1);assert.equal(sprite.frames[0],8);
  await assert.rejects(()=>inspectSprite(bytes,2));
  await assert.rejects(()=>inspectSprite(Buffer.from('not an image'),1));
});
test('official A2A client interoperates with a v0.3 Agent Card and keeps context',async()=>{
  let requests=[];let origin;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/.well-known/agent-card.json'){
      res.end(JSON.stringify({name:'Test Peer',description:'Protocol fixture',url:origin+'/rpc',protocolVersion:'0.3.0',version:'1.0.0',capabilities:{streaming:false},defaultInputModes:['text/plain'],defaultOutputModes:['text/plain'],skills:[{id:'discuss',name:'Discuss',description:'Structured discussion',tags:['discussion']}]}));return;
    }
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const request=JSON.parse(Buffer.concat(chunks));requests.push(request);
    res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{kind:'message',role:'agent',messageId:randomUUID(),contextId:'peer-context',parts:[{kind:'text',text:'{"message":"公开观点","proposal":"共享记录"}'}]}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  try{
    const provider=await discoverA2A(origin+'/');assert.equal(provider.name,'Test Peer');
    const adapter=new A2AAdapter(provider,{model:'default',parameters:{},localSession:null});
    const first=await adapter.run('讨论共享记录',()=>{},()=>{},new AbortController().signal);
    const second=await adapter.run('继续讨论',()=>{},()=>{},new AbortController().signal);
    assert.equal(first.sessionId,'peer-context');assert.equal(second.sessionId,'peer-context');
    assert.equal(requests[0].method,'message/send');
    assert.equal(requests[1].params.message.contextId,'peer-context');
    assert.ok(first.text.includes('公开观点'));
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
