import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.mjs";
test("conversation, members, native session and records survive restart", () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "talkwithpeer-"));
  const file = path.join(folder, "state.sqlite");
  let store = new Store(file);
  try {
    const c = store.createConversation({
      title: "共识讨论",
      projectPath: "/project",
    });
    const member = store.addMember(c.id, {
      providerId: "codex",
      model: "gpt-6.1-sol",
      parameters: { effort: "low" },
    });
    store.patchMember(member.id, { localSession: "native-123" });
    store.addMessage(c.id, {
      author: member.id,
      content: "公开观点",
      status: "streaming",
    });
    store.event(c.id, member.id, "progress", "正在分析问题");
    store.saveRequest({
      id: "request-1",
      conversationId: c.id,
      memberId: member.id,
      createdAt: new Date().toISOString(),
      input: "原始平台请求",
      inputHash: "hash",
      status: "pending",
    });
    store.saveSetting("context:" + c.id, {
      task: {
        revision: 1,
        constraints: [{ id: "constraint", text: "保留原文" }],
      },
      checkpoints: [
        { id: "checkpoint", schemaVersion: 2, coveredSourceIds: [] },
      ],
    });
    store.patchConversation(c.id, { status: "running" });
    store.close();
    store = new Store(file);
    assert.equal(store.conversation(c.id).status, "paused");
    assert.equal(store.member(member.id).localSession, member.platformSession);
    assert.equal(store.member(member.id).remoteSession, "native-123");
    assert.equal(store.messages(c.id)[0].status, "interrupted");
    assert.equal(store.messages(c.id)[0].content, "公开观点");
    assert.equal(store.events(c.id, member.id).length, 1);
    assert.equal(store.request("request-1").status, "interrupted");
    assert.equal(store.request("request-1").input, "原始平台请求");
    assert.equal(store.requests(c.id)[0].input, undefined);
    assert.equal(
      store.setting("context:" + c.id).task.constraints[0].text,
      "保留原文",
    );
    store.patchMember(member.id, { active: false });
    assert.equal(store.members(c.id).length, 0);
    assert.equal(store.messages(c.id).length, 1);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
