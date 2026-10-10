import test from "node:test";
import assert from "node:assert/strict";
import { validateDocument, decodeDocumentText, documentMemo } from "../shared/document-import.mjs";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createApp} from "../server/index.mjs";
import {connectLocal} from "../bin/twp.mjs";

test("resume imports validate size and actual supported file names before reading", () => {
  assert.equal(validateDocument({name:"简历.PDF",size:1024}), "pdf");
  assert.equal(validateDocument({name:"CV.docx",size:5*1024*1024}), "docx");
  assert.throws(() => validateDocument({name:"CV.doc",size:100}), /PDF.*DOCX/);
  assert.throws(() => validateDocument({name:"CV.pdf.exe",size:100}), /PDF.*DOCX/);
  assert.throws(() => validateDocument({name:"CV.pdf",size:5*1024*1024+1}), /5MB/);
  assert.throws(() => validateDocument({name:"CV.txt",size:0}), /空/);
});

test("text imports preserve Chinese and reject binary or invalid UTF-8 instead of replacement", () => {
  assert.equal(decodeDocumentText(new TextEncoder().encode("姓名：测试\r\n项目：A2A")), "姓名：测试\r\n项目：A2A");
  assert.throws(() => decodeDocumentText(Uint8Array.of(0xff)), /UTF-8/);
  assert.throws(() => decodeDocumentText(Uint8Array.of(65,0,66)), /文本/);
});

test("confirmed memo identifies the source file while preserving user-corrected text", () => {
  const document = {name:"简历\n假标题.pdf",hash:"a".repeat(64)};
  const memo = documentMemo(document,"  项目：修正后的描述  ");
  assert.ok(memo.includes("简历 假标题.pdf"));
  assert.ok(memo.includes("原文件 SHA-256："+document.hash));
  assert.ok(memo.endsWith("项目：修正后的描述"));
  assert.throws(() => documentMemo(document,"  "), /文字/);
  assert.throws(() => documentMemo(document,"中".repeat(8000)), /8000/);
  const prefix = documentMemo(document,"x").length-1;
  assert.equal(documentMemo(document,"中".repeat(8000-prefix)).length,8000);
  assert.throws(() => documentMemo(document,"中".repeat(8001-prefix)), /8000/);
});

test("confirmed resume is saved once, shared with every member, survives project changes and stays in its conversation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"twp-doc-import-"));
  const app = await createApp({root,registry:{list:()=>[],refresh:async()=>[],closeMember(){},close(){}}});
  await new Promise(resolve => app.server.listen(0,"127.0.0.1",resolve));
  let connection;
  try {
    connection = await connectLocal(app.server.address().port);
    const {conversation} = await connection.request("/conversations","POST",{});
    const other = app.store.createConversation();
    const members = ["Codex","Cursor","Reasonix"].map(name => app.store.addMember(conversation.id,{name,providerId:"fixture",model:"fixture",parameters:{}}));
    const memo = documentMemo({name:"fixture-resume.txt",hash:"a".repeat(64)},"模拟简历：独立实现 A2A 项目。");
    const {note} = await connection.request("/conversations/"+conversation.id+"/memo","POST",{text:memo});
    assert.equal(note.memberId,null);
    assert.equal(app.engine.context.state(conversation.id).notes.length,1);
    await connection.request("/conversations/"+conversation.id,"PATCH",{projectPath:root});
    for (const member of members) {
      const projection = app.engine.context.project(app.engine.snapshot(conversation.id,members),member.id);
      assert.ok(projection.memo.some(n => n.id === note.id && n.text === memo));
    }
    assert.equal((await connection.request("/conversations/"+other.id+"/context")).state.notes.length,0);
    await assert.rejects(connection.request("/conversations/"+conversation.id+"/memo","POST",{text:"x".repeat(8001)}),/8000/);
    assert.equal(app.engine.context.state(conversation.id).notes.length,1);
    await connection.request("/conversations/"+conversation.id+"/memo/"+note.id,"DELETE",{});
    assert.equal(app.engine.context.state(conversation.id).notes.length,0);
  } finally {
    await connection?.close();
    await app.close();
    await rm(root,{recursive:true,force:true});
  }
});
