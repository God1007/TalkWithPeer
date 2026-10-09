import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.mjs';
import {DiscussionEngine} from '../server/engine.mjs';
const setup=mode=>{
  const store=new Store(':memory:');const c=store.createConversation();const members=['A','B','C'].map(name=>store.addMember(c.id,{name,providerId:'codex',model:'model',parameters:{}}));
  const calls=[];const registry={validateMember(){},closeMember(){},async driver(member){return{sessionId:'native-'+member.id,async run(prompt,_delta,_activity,signal){
    calls.push({id:member.id,prompt});if(signal.aborted)throw new Error('cancelled');
    const match=prompt.match(/"candidateId":"([^"]+)"/);const candidateId=match?.[1];
    if(!candidateId)return{text:JSON.stringify({message:member.name+' 的公开观点',proposal:'共享上下文'}),sessionId:'native-'+member.id,model:'model'};
    if(mode==='error'&&member.name==='B')return{text:'not JSON',sessionId:'native-'+member.id,model:'model'};
    const conflict=mode==='deadlock'&&['A','B'].includes(member.name);
    const other=members.find(m=>m.name===(member.name==='A'?'B':'A'));
    return{text:JSON.stringify({message:member.name+' 的判断',candidateId,stance:conflict?'reject':'accept',proposal:null,disagreements:conflict?[{memberId:other.id,reason:member.name+' 保留不可让步立场',nonNegotiable:true}]:[]}),sessionId:'native-'+member.id,model:'model'};
  }}}};
  return{store,c,members,calls,engine:new DiscussionEngine(store,registry)};
};
test('orchestration records unanimous result and native sessions',async()=>{
  const s=setup('agree');try{await s.engine.start(s.c.id,'如何共享记录？');const c=s.store.conversation(s.c.id);assert.equal(c.status,'consensus');assert.equal(c.result.votes.length,3);assert.ok(s.store.members(c.id).every(m=>m.localSession));assert.equal(s.store.messages(c.id).filter(m=>m.kind==='result').length,1);assert.ok(s.calls[3].prompt.includes('A 的公开观点'));}finally{s.store.close();}
});
test('mutual holdout becomes deadlock after two review rounds',async()=>{
  const s=setup('deadlock');try{await s.engine.start(s.c.id,'讨论分歧');const c=s.store.conversation(s.c.id);assert.equal(c.status,'deadlock');assert.equal(c.result.round,2);assert.equal(c.result.positions.length,2);}finally{s.store.close();}
});
test('invalid judgments pause without fabricating consensus',async()=>{
  const s=setup('error');try{await s.engine.start(s.c.id,'讨论结果');assert.equal(s.store.conversation(s.c.id).status,'paused');assert.equal(s.store.messages(s.c.id).filter(m=>m.kind==='result').length,0);}finally{s.store.close();}
});
