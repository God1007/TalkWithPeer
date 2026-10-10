import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {transformWithOxc} from "vite";
import {documentMemo,importedDocuments} from "../shared/document-import.mjs";

test("a delayed context response cannot restore a deleted file when workspace refresh fails", async () => {
  const app = await readFile(new URL("../src/main.jsx",import.meta.url),"utf8");
  const start = app.indexOf("function ImportedFiles(");
  const end = app.indexOf("function App()",start);
  assert.ok(start >= 0 && end > start);
  const {code} = await transformWithOxc(app.slice(start,end),"ImportedFiles.jsx",{jsx:{runtime:"classic"}});
  const state=[],effects=[],requests=[];
  let cursor=0,deleteFailure=false;
  const useState = initial => {
    const i=cursor++;
    if(!(i in state))state[i]=initial;
    return [state[i],value => {state[i]=typeof value === "function" ? value(state[i]) : value;}];
  };
  const useRef = initial => useState({current:initial})[0];
  const useEffect = (effect,deps) => {
    const i=cursor++,old=effects[i];
    if(!old || deps.some((value,j)=>value!==old.deps[j])) {
      old?.cleanup?.();
      effects[i]={deps,cleanup:effect()};
    }
  };
  const React={createElement:(type,props,...children)=>({type,props:{...props,children}})};
  const IconButton=()=>null;
  const api = (url,method="GET") => {
    if(method==="DELETE")return deleteFailure ? Promise.reject(new Error("permission denied")) : Promise.resolve({removed:true});
    assert.match(url,/\/context$/);
    const pending=Promise.withResolvers();
    requests.push(pending);
    return pending.promise;
  };
  // Compile the real component; control only hook state and transport ordering, not its callbacks.
  const Component=new Function("React","useState","useRef","useEffect","api","importedDocuments","ErrorLine","IconButton","FileText","X",code+"\nreturn ImportedFiles;")(
    React,useState,useRef,useEffect,api,importedDocuments,()=>null,IconButton,()=>null,()=>null,
  );
  const render = revision => {cursor=0; return Component({conversationId:"fixture",revision,running:false,onChange:async()=>{throw new Error("workspace refresh failed");}});};
  const nodes = node => !node || typeof node!=="object" ? [] :
    [node,...(node.props?.children ?? []).flat(Infinity).flatMap(nodes)];
  const removeButtons = tree => nodes(tree).filter(node=>node.type===IconButton);
  const flush = async () => {await Promise.resolve(); await Promise.resolve();};
  const note={id:"original",memberId:null,text:documentMemo({name:"fixture.txt",hash:"a".repeat(64)},"synthetic source")};

  render(1);
  requests[0].resolve({state:{notes:[note]}});
  await flush();
  assert.equal(removeButtons(render(1)).length,1);
  const tree=render(2); // A new context read is in flight while the existing file remains visible.
  await removeButtons(tree)[0].props.onClick();
  assert.equal(removeButtons(render(2)).length,0);
  requests[1].resolve({state:{notes:[note]}}); // Snapshot captured before the successful DELETE.
  await flush();
  assert.equal(removeButtons(render(2)).length,0,"stale GET must not resurrect a successfully removed file");

  render(3);
  requests[2].resolve({state:{notes:[{...note,id:"new-upload"}]}});
  await flush();
  assert.equal(removeButtons(render(3)).length,1,"a subsequent fresh read must still display a new upload");
  deleteFailure=true;
  await removeButtons(render(4))[0].props.onClick();
  assert.equal(removeButtons(render(4)).length,1,"a failed DELETE must retain the existing file");
  requests[3].resolve({state:{notes:[{...note,id:"new-upload"},{...note,id:"another-upload"}]}});
  await flush();
  assert.equal(removeButtons(render(4)).length,2,"a failed DELETE must not invalidate a valid in-flight read");
  for(const effect of effects)effect?.cleanup?.();
});
