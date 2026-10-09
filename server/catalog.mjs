import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {RpcPeer} from './rpc.mjs';
import {LIVE_AGENTS,safeError} from './native-adapters.mjs';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
const exec=promisify(execFile);

export function cursorModels(stdout) {
  const rows=stdout.split('\n').map(line=>line.match(/^([a-z0-9][a-z0-9.[\]_-]+)\s+-\s+(.+)$/i)).filter(Boolean).map(match=>({id:match[1],name:match[2],parameters:[]}));
  for(const model of rows){
    const match=model.id.match(/^(.*)-(none|minimal|low|medium|high|xhigh|max)(-fast)?$/);
    if(!match)continue;
    const variants={};for(const row of rows){const m=row.id.match(/^(.*)-(none|minimal|low|medium|high|xhigh|max)(-fast)?$/);if(m&&m[1]===match[1]&&(m[3]??'')===(match[3]??''))variants[m[2]]=row.id;}
    model.variants=variants;model.defaultEffort=match[2];
    model.parameters=[{id:'effort',label:'推理强度',options:Object.keys(variants),default:match[2]}];
  }
  return rows;
}
export async function discoverNative(root) {
  await mkdir(root,{recursive:true});
  return Promise.all(LIVE_AGENTS.map(async agent=>{
    const provider={id:agent.id,name:agent.name,kind:agent.id,models:[],available:false,parameters:[]};
    let rpc;
    try{
      const {stdout}=await exec(agent.command,['--version'],{timeout:10000});provider.version=stdout.trim().split('\n')[0];provider.available=true;
      if(agent.id==='codex'){
        rpc=new RpcPeer('codex',['app-server','--stdio'],root);
        await rpc.call('initialize',{clientInfo:{name:'talkwithpeer_catalog',version:'0.1.0'}},30000);rpc.notify('initialized');
        const result=await rpc.call('model/list',{limit:100},30000);
        provider.models=result.data.filter(model=>!model.hidden).map(model=>({id:model.model,name:model.displayName,default:model.isDefault,parameters:[{id:'effort',label:'推理强度',options:model.supportedReasoningEfforts.map(e=>e.reasoningEffort),default:model.defaultReasoningEffort}]}));
      }else if(agent.id==='cursor'){
        const {stdout}=await exec('cursor-agent',['models'],{timeout:30000,maxBuffer:2_000_000});provider.models=cursorModels(stdout);
      }else{
        const cwd=path.join(root,'reasonix');await mkdir(cwd,{recursive:true});
        rpc=new RpcPeer('reasonix',['acp','--workspace-only'],cwd);
        await rpc.call('initialize',{protocolVersion:1,clientInfo:{name:'talkwithpeer_catalog',version:'0.1.0'},clientCapabilities:{}},30000);
        const result=await rpc.call('session/new',{cwd,mcpServers:[]},30000);
        const options=result.configOptions??[];
        const effort=options.find(o=>o.id==='effort');
        provider.models=(options.find(o=>o.id==='model')?.options??[]).map(option=>({id:option.value,name:option.name??option.value,parameters:effort?[{id:'effort',label:'推理强度',options:effort.options.map(o=>o.value),default:effort.currentValue}]:[]}));
      }
      if(!provider.models.length)throw new Error('未发现可用模型。');
      return provider;
    }catch(error){provider.error=safeError(error);return provider;}
    finally{rpc?.stop();}
  }));
}
export function resolveModel(provider,member) {
  const model=provider.models.find(model=>model.id===member.model);
  if(!model)throw new Error('模型不在当前 Agent 的能力列表中。');
  const parameters={};
  if(Object.keys(member.parameters??{}).some(key=>!(model.parameters??[]).some(descriptor=>descriptor.id===key)))throw new Error('包含当前模型不支持的参数。');
  for(const descriptor of model.parameters??[]){
    const value=member.parameters?.[descriptor.id]??descriptor.default;
    if(value!==undefined&&!descriptor.options.includes(value))throw new Error('模型参数不受当前 Agent 支持：'+descriptor.label);
    if(value!==undefined)parameters[descriptor.id]=value;
  }
  return{model:provider.kind==='cursor'&&model.variants?model.variants[parameters.effort]??model.id:model.id,parameters};
}
