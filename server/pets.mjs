import {readdir,readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import https from 'node:https';
import dns from 'node:dns/promises';
import sharp from 'sharp';

const maxBytes=20*1024*1024;
const codexPets=path.join(process.env.CODEX_HOME??path.join(os.homedir(),'.codex'),'pets');
export function parsePetLink(input) {
  let url;try{url=new URL(input);}catch{throw new Error('请输入有效的 Codex pet 安装链接。');}
  if(url.protocol!=='codex:'||url.hostname!=='pets'||url.pathname!=='/install')throw new Error('这不是 Codex pet 安装链接。');
  const allowed=['name','imageUrl','description','spriteVersionNumber'];
  if([...url.searchParams.keys()].some(k=>!allowed.includes(k)))throw new Error('pet 链接包含不支持的参数。');
  const name=url.searchParams.get('name')?.trim();const version=Number(url.searchParams.get('spriteVersionNumber')??1);
  const imageUrl=new URL(url.searchParams.get('imageUrl'));
  if(!name||name.length>80||imageUrl.protocol!=='https:'||imageUrl.username||imageUrl.password||![1,2].includes(version))throw new Error('pet 名称、图片地址或 sprite 版本无效。');
  return{name,description:(url.searchParams.get('description')??'').slice(0,500),version,imageUrl:imageUrl.href};
}
export async function inspectSprite(bytes,version) {
  if(!Buffer.isBuffer(bytes)||bytes.length>maxBytes)throw new Error('pet 图片不能超过 20 MiB。');
  const image=sharp(bytes,{limitInputPixels:4_000_000});
  const meta=await image.metadata();
  if(!['png','webp'].includes(meta.format)||meta.width!==1536||meta.height!==(version===2?2288:1872))throw new Error('sprite 尺寸不匹配：v1 为 1536×1872，v2 为 1536×2288。');
  if(!meta.hasAlpha)throw new Error('pet sprite 需要透明背景。');
  const {data,info}=await image.ensureAlpha().raw().toBuffer({resolveWithObject:true});const frames=[];
  for(let row=0;row<meta.height/208;row++){
    let count=0;
    for(let col=0;col<8;col++){
      let visible=false;
      for(let y=row*208;y<(row+1)*208&&!visible;y++)for(let x=col*192;x<(col+1)*192;x++)if(data[(y*info.width+x)*4+3]>8){visible=true;break;}
      if(visible)count=col+1;
    }
    frames.push(count);
  }
  if(!frames[0])throw new Error('pet 的 idle 行没有可显示的内容。');
  return{width:meta.width,height:meta.height,format:meta.format,frames};
}
function publicAddress(address) {
  if(address.includes(':'))return !/^(::|fc|fd|fe[89ab])/i.test(address)&&!address.toLowerCase().includes('ffff:');
  const p=address.split('.').map(Number);
  return p.length===4&&p[0]>0&&p[0]!==10&&p[0]!==127&&p[0]!==169&&p[0]<224&&!(p[0]===172&&p[1]>=16&&p[1]<=31)&&!(p[0]===192&&p[1]===168)&&!(p[0]===100&&p[1]>=64&&p[1]<=127);
}
async function downloadImage(url,redirects=0) {
  if(redirects>3)throw new Error('图片地址重定向过多。');
  const target=new URL(url);if(target.protocol!=='https:'||target.username||target.password)throw new Error('图片只能使用 HTTPS 地址。');
  const addresses=await dns.lookup(target.hostname,{all:true});
  if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('图片链接不能指向本机或私有网络。');
  return new Promise((resolve,reject)=>{
    const request=https.get(target,{headers:{Accept:'image/png,image/webp'},lookup:(_host,options,callback)=>{const found=addresses.find(a=>!options.family||a.family===options.family)??addresses[0];if(options.all)callback(null,[found]);else callback(null,found.address,found.family);}},response=>{
      if([301,302,303,307,308].includes(response.statusCode)&&response.headers.location){response.resume();downloadImage(new URL(response.headers.location,target).href,redirects+1).then(resolve,reject);return;}
      if(response.statusCode!==200){response.resume();reject(new Error('pet 图片下载失败：HTTP '+response.statusCode));return;}
      const chunks=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)request.destroy(new Error('pet 图片超过 20 MiB。'));else chunks.push(chunk);});
      response.on('end',()=>resolve(Buffer.concat(chunks)));response.on('error',reject);
    });
    request.setTimeout(15000,()=>request.destroy(new Error('pet 图片下载超时。')));request.on('error',reject);
  });
}
export async function listCodexPets(root=codexPets) {
  let entries;try{entries=await readdir(root,{withFileTypes:true});}catch{return [];}
  const result=[];
  for(const entry of entries.filter(e=>e.isDirectory())){
    try{const meta=JSON.parse(await readFile(path.join(root,entry.name,'pet.json'),'utf8'));result.push({id:entry.name,name:meta.displayName??entry.name,description:meta.description??'',version:meta.spriteVersionNumber??1});}catch{}
  }
  return result;
}
export class PetLibrary {
  constructor(store,root){this.store=store;this.root=root;}
  list(){return this.store.setting('pets',[]);}
  async save(bytes,{name,description='',version=1,source='link'}){
    if(!name||name.length>80)throw new Error('pet 名称无效。');
    const info=await inspectSprite(bytes,version);const hash=createHash('sha256').update(bytes).digest('hex');
    const existing=this.list().find(p=>p.hash===hash);if(existing)return existing;
    await mkdir(this.root,{recursive:true});const id=randomUUID();const filename=id+'.'+info.format;
    await writeFile(path.join(this.root,filename),bytes,{flag:'wx'});
    const pet={id,name,description,version,source,filename,hash,...info};this.store.saveSetting('pets',[...this.list(),pet]);return pet;
  }
  async importLink(link){const meta=parsePetLink(link);return this.save(await downloadImage(meta.imageUrl),{...meta,source:'link'});}
  async importCodex(id){
    if(typeof id!=='string'||!/^[a-zA-Z0-9_-]+$/.test(id))throw new Error('Codex pet 标识无效。');
    const folder=await realpath(path.join(codexPets,id));const root=await realpath(codexPets);if(!folder.startsWith(root+path.sep))throw new Error('pet 路径无效。');
    const meta=JSON.parse(await readFile(path.join(folder,'pet.json'),'utf8'));
    const asset=await realpath(path.resolve(folder,meta.spritesheetPath));if(!asset.startsWith(folder+path.sep))throw new Error('sprite 路径无效。');
    return this.save(await readFile(asset),{name:meta.displayName??id,description:meta.description??'',version:meta.spriteVersionNumber??1,source:'codex'});
  }
  async read(id){const pet=this.list().find(p=>p.id===id);if(!pet)throw new Error('pet 不存在。');return{pet,bytes:await readFile(path.join(this.root,pet.filename))};}
}
