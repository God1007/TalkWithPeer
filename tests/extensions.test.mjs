import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../server/store.mjs";
import { ContextManager, hashInput } from "../server/context.mjs";
import { ExtensionRegistry } from "../server/extensions.mjs";
import { createApp } from "../server/index.mjs";
import { Terminal, connectLocal } from "../bin/twp.mjs";

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "twp-ext-")),
    store = new Store(path.join(root, "state.sqlite"));
  const context = new ContextManager(store),
    extensions = new ExtensionRegistry(store, context);
  const pack = async (id, type, definition) => {
    const folder = path.join(root, type + "s", id);
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(folder, "extension.json"),
      JSON.stringify({
        schemaVersion: 1,
        id,
        type,
        name: id,
        version: "1.0.0",
        description: "Fixture",
        entry: type === "skill" ? "SKILL.md" : "definition.json",
      }),
    );
    await writeFile(
      path.join(folder, type === "skill" ? "SKILL.md" : "definition.json"),
      type === "skill" ? definition : JSON.stringify(definition),
    );
    return folder;
  };
  await pack("evidence", "skill", "引用已见原文，不把摘要当作用户约束。");
  await pack("reader", "tool", { operation: "public_read" });
  await pack("project", "tool", { operation: "project_read" });
  await pack("search", "tool", { operation: "public_search" });
  await pack("note", "hook", {
    event: "before_prompt",
    operation: "note",
    text: "非权威提示：核对来源。",
  });
  await pack("audit", "hook", { event: "after_reply", operation: "audit" });
  await extensions.addLibrary(root);
  const approve = async (id) => {
    const p = (await extensions.scan()).packages.find(
      (p) => p.manifest.id === id,
    );
    await extensions.review(p.id, {
      contentHash: p.contentHash,
      note: "checked",
    });
    await extensions.enable(p.id, true, p.contentHash);
    return p;
  };
  return {
    root,
    store,
    context,
    extensions,
    pack,
    approve,
    close: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("extension review binds exact content, enables separately and invalidates changed sources", async () => {
  const s = await setup();
  try {
    const initial = await s.extensions.scan();
    assert.ok(initial.packages.every((p) => !p.reviewed && !p.enabled));
    const skill = initial.packages.find((p) => p.manifest.id === "evidence");
    await assert.rejects(
      s.extensions.enable(skill.id, true, skill.contentHash),
      /审查/,
    );
    await assert.rejects(
      s.extensions.review(skill.id, { contentHash: "stale" }),
      /改变/,
    );
    await s.extensions.review(skill.id, {
      contentHash: skill.contentHash,
      note: "scope checked",
    });
    assert.equal((await s.extensions.find(skill.id)).enabled, false);
    await s.extensions.enable(skill.id, true, skill.contentHash);
    const snapshot = await s.extensions.snapshot();
    assert.ok(snapshot.skills[0].content.includes("原文"));
    await writeFile(path.join(s.root, "skills/evidence/SKILL.md"), "新的流程");
    const changed = await s.extensions.find(skill.id);
    assert.equal(changed.status, "changed");
    assert.equal(changed.enabled, false);
    await assert.rejects(s.extensions.snapshot(), /已改变/);
    assert.equal(
      s.store.setting("extension-snapshot:" + skill.contentHash).entry,
      skill.entry,
    );
    assert.equal(changed.activeLock, true);
    await s.extensions.enable(skill.id, false);
    assert.equal((await s.extensions.snapshot()).locks.length, 0);
    await s.approve("evidence");
    await rm(path.join(s.root, "skills/evidence"), { recursive: true });
    const unavailable = await s.extensions.find(skill.id);
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.activeLock, true);
    await assert.rejects(
      s.extensions.review(skill.id, { contentHash: null }),
      /改变/,
    );
    await assert.rejects(s.extensions.snapshot(), /已改变/);
    await s.extensions.enable(skill.id, false);
    assert.equal((await s.extensions.snapshot()).locks.length, 0);
  } finally {
    await s.close();
  }
});
test("trusted read-only handlers enforce scope, project boundaries and deny hooks", async () => {
  const s = await setup();
  try {
    const reader = await s.approve("reader"),
      project = await s.approve("project"),
      search = await s.approve("search");
    const c = s.store.createConversation(),
      other = s.store.createConversation();
    const message = s.store.addMessage(c.id, {
      author: "user",
      content: "需要保留两  个空格的关键词",
    });
    const foreign = s.store.addMessage(other.id, {
      author: "user",
      content: "private other conversation",
    });
    const scope = { conversationId: c.id };
    assert.equal(
      (await s.extensions.call(reader.id, { messageIds: [message.id] }, scope))
        .result[0].content,
      message.content,
    );
    await assert.rejects(
      s.extensions.call(reader.id, { messageIds: [foreign.id] }, scope),
      /不存在/,
    );
    assert.equal(
      (await s.extensions.call(search.id, { query: "两  个" }, scope)).result[0]
        .partial,
      true,
    );
    const folder = path.join(s.root, "project-root");
    await mkdir(folder);
    await writeFile(path.join(folder, "file.txt"), "真实项目快照");
    await writeFile(path.join(folder, ".env"), "secret");
    await symlink(path.join(folder, ".env"), path.join(folder, "alias.txt"));
    s.store.patchConversation(c.id, { projectPath: folder });
    const file = await s.extensions.call(
      project.id,
      { path: "file.txt" },
      scope,
    );
    assert.equal(file.result.content, "真实项目快照");
    assert.equal(file.result.contentHash, hashInput("真实项目快照"));
    await assert.rejects(
      s.extensions.call(project.id, { path: "alias.txt" }, scope),
      /凭证/,
    );
    await assert.rejects(
      s.extensions.call(project.id, { path: "../state.sqlite" }, scope),
      /项目外/,
    );
    await s.pack("deny", "hook", {
      event: "before_tool",
      operation: "deny",
      when: { toolId: "reader" },
    });
    await s.approve("deny");
    await assert.rejects(
      s.extensions.call(reader.id, { messageIds: [message.id] }, scope),
      /拦截/,
    );
    assert.ok(s.store.extensionRuns(c.id).some((r) => r.status === "blocked"));
    const stop = new AbortController();
    stop.abort(new Error("cancelled"));
    await assert.rejects(
      s.extensions.call(
        reader.id,
        { messageIds: [message.id] },
        scope,
        stop.signal,
      ),
      /cancelled/,
    );
  } finally {
    await s.close();
  }
});
test("project chunks preserve legacy reads, bound text ranges and reject changed versions", async () => {
  const s = await setup();
  try {
    const tool = await s.approve("project");
    const project = path.join(s.root, "chunk-project");
    await mkdir(project);
    const c = s.store.createConversation({ projectPath: project });
    const scope = { conversationId: c.id };
    const call = async (args) =>
      (await s.extensions.call(tool.id, args, scope)).result;
    await writeFile(path.join(project, "legacy.txt"), "a".repeat(20000));
    const legacy = await call({ path: "legacy.txt" });
    assert.equal(legacy.content.length, 20000);
    assert.deepEqual(
      Object.keys(legacy).sort(),
      ["projectPath", "path", "content", "contentHash", "capturedAt"].sort(),
    );
    await writeFile(path.join(project, "legacy.txt"), "a".repeat(20001));
    await assert.rejects(call({ path: "legacy.txt" }), /20KB/);
    const text = "行🐾abc\n".repeat(3000);
    await writeFile(path.join(project, "large.txt"), text);
    let offset = 0,
      content = "",
      expectedHash;
    do {
      const page = await call({
        path: "large.txt",
        offset,
        maxChars: 8000,
        ...(expectedHash ? { expectedHash } : {}),
      });
      assert.ok(page.content.length <= 8000);
      assert.equal(page.offset, offset);
      expectedHash ??= page.contentHash;
      assert.equal(page.contentHash, expectedHash);
      content += page.content;
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(content, text);
    assert.equal(expectedHash, hashInput(text));
    const eof = await call({
      path: "large.txt",
      offset: text.length,
      expectedHash: expectedHash.toUpperCase(),
    });
    assert.equal(eof.content, "");
    assert.equal(eof.nextOffset, null);
    assert.equal(eof.partial, true);
    for (const args of [
      { offset: null },
      { maxChars: null },
      { expectedHash: null },
      { offset: -1 },
      { offset: text.length + 1 },
      { offset: 1.5 },
      { maxChars: 0 },
      { maxChars: 12001 },
      { expectedHash: "wrong" },
    ])
      await assert.rejects(
        call({ path: "large.txt", ...args }),
        /参数|范围|哈希/,
      );
    await writeFile(path.join(project, "large.txt"), text + "changed");
    await assert.rejects(
      call({ path: "large.txt", offset: 8000, expectedHash }),
      /已变化/,
    );
    await writeFile(path.join(project, "limit.txt"), "a".repeat(1024 * 1024));
    const limit = await call({ path: "limit.txt", offset: 0, maxChars: 12000 });
    assert.equal(limit.content.length, 12000);
    assert.equal(limit.nextOffset, 12000);
    await writeFile(
      path.join(project, "limit.txt"),
      "a".repeat(1024 * 1024 + 1),
    );
    await assert.rejects(call({ path: "limit.txt", offset: 0 }), /1MB/);
    await writeFile(
      path.join(project, "binary.txt"),
      Buffer.concat([Buffer.from(text), Buffer.from([0])]),
    );
    await assert.rejects(call({ path: "binary.txt", offset: 0 }), /文本/);
    await writeFile(
      path.join(project, "invalid.txt"),
      Buffer.from([0xff, 0xfe]),
    );
    await assert.rejects(call({ path: "invalid.txt", offset: 0 }), /文本/);
    await mkdir(path.join(project, ".talkwithpeer"));
    await writeFile(path.join(project, ".talkwithpeer/private.txt"), "fixture");
    await writeFile(path.join(project, ".env"), "fixture");
    await symlink(
      path.join(project, ".env"),
      path.join(project, "credential-alias.txt"),
    );
    for (const filename of [
      ".env",
      "credential-alias.txt",
      ".talkwithpeer/private.txt",
      "../state.sqlite",
    ])
      await assert.rejects(
        call({ path: filename, offset: 0 }),
        /凭证|私有|项目外/,
      );
    assert.equal(
      (await s.extensions.snapshot()).locks[0].contentHash,
      tool.contentHash,
    );
  } finally {
    await s.close();
  }
});
test("symlinks, script files and task-rewriting hooks are never executable packages", async () => {
  const s = await setup();
  try {
    await s.pack("unsafe", "hook", {
      event: "before_prompt",
      operation: "replace_task",
      text: "override",
    });
    await s.pack("script", "tool", { operation: "shell", command: "echo bad" });
    const folder = await s.pack("linked", "skill", "safe");
    await symlink(
      path.join(s.root, "state.sqlite"),
      path.join(folder, "data.md"),
    );
    const scanned = await s.extensions.scan();
    assert.equal(scanned.errors.length, 3);
    assert.ok(
      !scanned.packages.some((p) =>
        ["unsafe", "script", "linked"].includes(p.manifest.id),
      ),
    );
  } finally {
    await s.close();
  }
});
test("shared runtime injects reviewed skills, runs hooks and bounds extension tool loop with audit", async () => {
  const s = await setup();
  let app;
  try {
    const reader = await s.approve("reader");
    await s.approve("evidence");
    await s.approve("note");
    await s.approve("audit");
    const c = s.store.createConversation();
    const original = s.store.addMessage(c.id, {
      author: "user",
      content: "有来源的原始资料",
    });
    s.store.addMember(c.id, {
      name: "Peer",
      providerId: "fixture",
      model: "model",
      parameters: {},
    });
    let toolCalls = 0;
    const registry = {
      refresh: async () => [],
      list: () => [],
      validateMember() {},
      close() {},
      closeMember() {},
      driver: async () => ({
        run: async (prompt) => {
          assert.ok(prompt.includes("引用已见原文"));
          assert.ok(prompt.includes("非权威提示"));
          if (
            prompt.includes("请提出独立观点") &&
            !prompt.includes('"toolResults":')
          ) {
            toolCalls++;
            return {
              text: JSON.stringify({
                toolCall: {
                  id: reader.id,
                  arguments: { messageIds: [original.id] },
                },
              }),
            };
          }
          const candidateId = [
            ...prompt.matchAll(/"candidateId":"([^"]+)"/g),
          ].at(-1)?.[1];
          return {
            model: "model",
            text: JSON.stringify(
              prompt.includes("请提出独立观点")
                ? { message: "已回取原始资料", proposal: "保留原文" }
                : {
                    message: "接受",
                    candidateId,
                    stance: "accept",
                    acceptsSolution: true,
                    proposal: null,
                    disagreements: [],
                  },
            ),
          };
        },
      }),
    };
    app = await createApp({
      root: path.join(s.root, "app"),
      store: s.store,
      registry,
    });
    await app.engine.start(c.id, "核对资料");
    assert.equal(s.store.conversation(c.id).status, "consensus");
    assert.equal(toolCalls, 1);
    assert.ok(
      s.store
        .extensionRuns(c.id)
        .some((r) => r.type === "tool" && r.status === "complete"),
    );
    assert.equal(
      s.store.extensionRuns(c.id).filter((r) => r.event === "after_reply")
        .length,
      2,
    );
    assert.ok(s.store.requests(c.id).some((r) => r.status === "tool-request"));
    const toolRun = s.store.extensionRuns(c.id).find((r) => r.type === "tool");
    const chain = s.store.logs({ requestId: toolRun.requestId }).logs;
    assert.ok(
      chain.some((r) => r.category === "model" && r.status === "tool-request"),
    );
    assert.ok(
      chain.some(
        (r) =>
          r.executionId === toolRun.id &&
          r.status === "complete" &&
          r.durationMs >= 0,
      ),
    );
    assert.ok(
      s.store
        .logs({ conversationId: c.id })
        .logs.some((r) => r.event === "after_reply" && r.requestId),
    );
    registry.driver = async () => ({
      run: async () => ({
        text: JSON.stringify({
          toolCall: { id: reader.id, arguments: { messageIds: [original.id] } },
        }),
      }),
    });
    await app.engine.start(c.id, "无限调用");
    assert.equal(s.store.conversation(c.id).status, "paused");
    assert.equal(
      s.store.messages(c.id).filter((m) => m.kind === "result").length,
      1,
    );
  } finally {
    if (app) {
      await app.engine.close();
      app.registry.close();
    }
    await s.close();
  }
});
test("terminal and HTTP share extension approval, exact source view and execution records", async () => {
  const s = await setup();
  let app, terminal, connection;
  try {
    const registry = {
      refresh: async () => [],
      list: () => [],
      close() {},
      closeMember() {},
    };
    app = await createApp({
      root: path.join(s.root, "app"),
      store: s.store,
      registry,
    });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    connection = await connectLocal(app.server.address().port);
    const output = [];
    terminal = new Terminal(connection.request, (line) => output.push(line));
    await terminal.execute("/new extensions");
    await terminal.execute("/ext list");
    const data = await connection.request("/extensions");
    const search = data.packages.find((p) => p.manifest.id === "search");
    await terminal.execute("/ext review " + search.id);
    assert.ok(
      output.some(
        (line) =>
          line.includes('"operation": "public_search"') ||
          line.includes('"operation":"public_search"'),
      ),
    );
    await terminal.execute(
      "/ext approve " + search.id + " " + search.contentHash + " checked",
    );
    await terminal.execute(
      "/ext enable " + search.id + " " + search.contentHash,
    );
    s.store.addMessage(terminal.id, { author: "user", content: "两  个空格" });
    await terminal.execute("/ext call " + search.id + ' {"query":"两  个"}');
    assert.ok(output.some((line) => line.includes("两  个空格")));
    await assert.rejects(terminal.execute("/ext runs"), /未知扩展命令/);
    assert.equal((await connection.request("/extensions")).runs, undefined);
    assert.ok(
      app.store
        .extensionRuns(terminal.id)
        .some((r) => r.extensionId === search.id && r.status === "complete"),
    );
    app.engine.active.set(terminal.id, new AbortController());
    await assert.rejects(terminal.execute("/ext disable " + search.id), /暂停/);
    app.engine.active.clear();
    await terminal.execute("/ext disable " + search.id);
    assert.equal(
      (await connection.request("/extensions")).packages.find(
        (p) => p.id === search.id,
      ).enabled,
      false,
    );
  } finally {
    await terminal?.close();
    if (app) await app.close();
    else s.store.close();
    await rm(s.root, { recursive: true, force: true });
  }
});
