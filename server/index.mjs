import http from 'node:http';
import {readFile,readdir,stat,realpath,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Store} from './store.mjs';
import {AgentRegistry} from './registry.mjs';
import {DiscussionEngine} from './engine.mjs';
import {PetLibrary,listCodexPets} from './pets.mjs';
import {safeError} from './native-adapters.mjs';

const appRoot=fileURLToPath(new URL('../',import.meta.url));
const publicRoot=path.join(appRoot,'dist');
const dataRoot=process.env.TWP_DATA_DIR??path.join(appRoot,'.talkwithpeer');
export async function validProject(value) {
  if(typeof value!=='string'||!value.trim()||value.length>4000)throw new Error('请选择有效的本地项目目录。');
  const actual=await realpath(value);
  if(!(await stat(actual)).isDirectory()||actual===path.parse(actual).root||actual===os.homedir())throw new Error('请选择具体的项目目录。');
  return actual;
}
export async function createApp({root=dataRoot,store:providedStore,registry:providedRegistry}={}) {
  await mkdir(root,{recursive:true,mode:0o700});
  const store=providedStore??new Store(path.join(root,'workspace.sqlite'));
  const registry=providedRegistry??new AgentRegistry(store,path.join(root,'runtime'));
  const engine=new DiscussionEngine(store,registry);
  const pets=new PetLibrary(store,path.join(root,'pets'));
  const tokens=new Set();let discovering=true;
  const refresh=()=>registry.refresh().finally(()=>{discovering=false;});
  refresh().catch(()=>{discovering=false;});
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  const editable=id=>{if(engine.active.has(id))throw new Error('请先暂停讨论，再修改会话配置。');const c=store.conversation(id);if(!c)throw new Error('会话不存在。');return c;};
  const bump=id=>{const c=store.conversation(id);store.patchConversation(id,{contextVersion:c.contextVersion+1,candidate:null,result:null,status:'idle'});engine.update(id);};
  const server=http.createServer(async(req,res)=>{
    const port=server.address().port;
    const hosts=['127.0.0.1:'+port,'localhost:'+port];
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(!hosts.includes(req.headers.host)){json(res,403,{error:'仅允许本机访问。'});return;}
    const origin='http://'+req.headers.host;
    let url;try{url=new URL(req.url,origin);}catch{json(res,400,{error:'地址无效。'});return;}
    if(req.headers.origin&&req.headers.origin!==origin){json(res,403,{error:'不接受跨站请求。'});return;}
    if(req.headers['sec-fetch-site']==='cross-site'&&url.pathname.startsWith('/api/')){json(res,403,{error:'不接受跨站请求。'});return;}
    const cookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('twp_session='))?.slice(12);
    if(req.method==='GET'&&!url.pathname.startsWith('/api/')){
      if(url.pathname==='/'){
        if(!tokens.has(cookie)){const token=randomUUID();tokens.add(token);res.setHeader('Set-Cookie','twp_session='+token+'; HttpOnly; SameSite=Strict; Path=/');}
      }
      let relative;try{relative=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));}catch{json(res,400,{error:'页面地址无效。'});return;}
      const filename=path.resolve(publicRoot,relative);
      if(!filename.startsWith(publicRoot+path.sep)){json(res,404,{error:'页面不存在。'});return;}
      try{
        const actual=await realpath(filename);if(!actual.startsWith(publicRoot+path.sep))throw new Error();
        const content=await readFile(actual);const ext=path.extname(actual);const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2'};
        res.writeHead(200,{'Content-Type':mime[ext]??'application/octet-stream'});res.end(content);
      }catch{json(res,404,{error:'页面不存在。请先构建前端。'});}return;
    }
    if(!tokens.has(cookie)){json(res,401,{error:'请从本机工作台打开会话。'});return;}
    if(!['GET','POST','PATCH','DELETE'].includes(req.method)){json(res,405,{error:'请求方式不支持。'});return;}
    let body={};
    if(req.method!=='GET'){
      if(req.headers['x-twp']!=='1'||!req.headers['content-type']?.startsWith('application/json')){json(res,403,{error:'请求格式无效。'});return;}
      try{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>100000){json(res,413,{error:'请求内容过大。'});return;}chunks.push(chunk);}body=JSON.parse(Buffer.concat(chunks).toString());}
      catch{json(res,400,{error:'JSON 请求无效。'});return;}
      if(!body||typeof body!=='object'||Array.isArray(body)){json(res,400,{error:'请求内容无效。'});return;}
    }
    const pieces=url.pathname.split('/').filter(Boolean);
    try{
      if(url.pathname==='/api/bootstrap'&&req.method==='GET'){json(res,200,{conversations:store.listConversations(),providers:registry.list(),pets:pets.list(),discovering,home:os.homedir(),local:true});return;}
      if(url.pathname==='/api/providers/refresh'&&req.method==='POST'){discovering=true;json(res,200,{providers:await refresh()});return;}
      if(url.pathname==='/api/providers'&&req.method==='POST'){json(res,201,{provider:await registry.addA2A({cardUrl:body.cardUrl,tokenEnv:body.tokenEnv})});return;}
      if(url.pathname==='/api/pets'&&req.method==='GET'){json(res,200,{pets:pets.list(),codex:await listCodexPets()});return;}
      if(url.pathname==='/api/pets/import'&&req.method==='POST'){
        const pet=body.source==='codex'?await pets.importCodex(body.id):body.source==='link'?await pets.importLink(body.link):null;if(!pet)throw new Error('请选择 pet 来源。');
        json(res,201,{pet});return;
      }
      if(pieces[1]==='pets'&&pieces[3]==='sprite'&&req.method==='GET'){
        const {pet,bytes}=await pets.read(pieces[2]);res.writeHead(200,{'Content-Type':'image/'+pet.format,'Cache-Control':'private, max-age=86400'});res.end(bytes);return;
      }
      if(url.pathname==='/api/projects/browse'&&req.method==='GET'){
        const requested=url.searchParams.get('path')??path.join(os.homedir(),'Documents');const current=await realpath(requested);
        if(!(await stat(current)).isDirectory())throw new Error('路径不是目录。');
        const entries=await readdir(current,{withFileTypes:true});const directories=entries.filter(e=>e.isDirectory()&&!e.name.startsWith('.')).map(e=>({name:e.name,path:path.join(current,e.name)})).sort((a,b)=>a.name.localeCompare(b.name));
        json(res,200,{path:current,parent:path.dirname(current),directories:directories.slice(0,250)});return;
      }
      if(url.pathname==='/api/conversations'&&req.method==='POST'){
        const title=typeof body.title==='string'?body.title.trim().slice(0,100)||'新会话':'新会话';
        json(res,201,{conversation:store.createConversation({title})});return;
      }
      if(pieces[1]==='conversations'&&pieces[2]){
        const id=pieces[2];const c=store.conversation(id);if(!c){json(res,404,{error:'会话不存在。'});return;}
        if(pieces.length===3&&req.method==='GET'){json(res,200,store.workspace(id));return;}
        if(pieces.length===3&&req.method==='PATCH'){
          editable(id);const patch={};
          if(Object.hasOwn(body,'title')){if(typeof body.title!=='string'||!body.title.trim()||body.title.length>100)throw new Error('会话名称无效。');patch.title=body.title.trim();}
          if(Object.hasOwn(body,'projectPath')){patch.projectPath=body.projectPath===null?null:await validProject(body.projectPath);editable(id);for(const member of store.members(id)){registry.closeMember(member.id);store.patchMember(member.id,{localSession:null,lastSyncedMessageId:null,syncedVersion:null});}}
          store.patchConversation(id,patch);if(Object.hasOwn(patch,'projectPath'))bump(id);else engine.update(id);json(res,200,store.workspace(id));return;
        }
        if(pieces[3]==='members'&&pieces.length===4&&req.method==='POST'){
          editable(id);if(store.members(id).length>=8)throw new Error('一期每个会话最多支持 8 位参与者。');
          const input=registry.validateMember(body);if(input.petId&&!pets.list().some(p=>p.id===input.petId))throw new Error('pet 不存在。');
          const member=store.addMember(id,input);bump(id);json(res,201,{member});return;
        }
        if(pieces[3]==='members'&&pieces[4]){
          const member=store.member(pieces[4]);if(!member||member.conversationId!==id){json(res,404,{error:'参与者不存在。'});return;}
          if(req.method==='GET'){json(res,200,{member,events:store.events(id,member.id),messages:store.messages(id).filter(m=>m.author===member.id)});return;}
          editable(id);
          if(req.method==='PATCH'){
            const input=registry.validateMember({...member,...body});if(input.petId&&!pets.list().some(p=>p.id===input.petId))throw new Error('pet 不存在。');
            registry.closeMember(member.id);store.patchMember(member.id,input);bump(id);json(res,200,{member:store.member(member.id)});return;
          }
          if(req.method==='DELETE'){registry.closeMember(member.id);store.patchMember(member.id,{active:false});bump(id);json(res,200,{removed:true});return;}
        }
        if(pieces[3]==='discuss'&&req.method==='POST'){engine.start(id,body.text,{maxRounds:body.maxRounds??4});json(res,202,{started:true});return;}
        if(pieces[3]==='continue'&&req.method==='POST'){engine.start(id,null,{resume:true,maxRounds:body.maxRounds??4});json(res,202,{started:true});return;}
        if(pieces[3]==='stop'&&req.method==='POST'){engine.stop(id);json(res,200,{requested:true});return;}
        if(pieces[3]==='stream'&&req.method==='GET'){
          res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','X-Accel-Buffering':'no','Connection':'keep-alive'});
          const send=event=>{if(!res.destroyed)res.write('data: '+JSON.stringify(event)+'\n\n');};
          send({type:'workspace'});
          engine.on(id,send);const ping=setInterval(()=>{if(!res.destroyed)res.write(': keepalive\n\n');},15000);
          res.on('close',()=>{engine.off(id,send);clearInterval(ping);});return;
        }
      }
      json(res,404,{error:'接口不存在。'});
    }catch(error){json(res,400,{error:safeError(error)});}
  });
  return{server,store,registry,engine,pets,async close(){await engine.close();registry.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const app=await createApp();const port=Number(process.env.TWP_PORT??48273);
  app.server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'端口已被占用，请关闭旧服务后再启动。':'服务启动失败。');process.exitCode=1;});
  app.server.listen(port,'127.0.0.1',()=>console.log('TalkWithPeer: http://127.0.0.1:'+port+'/'));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>app.close().then(()=>process.exit(0)));
}
