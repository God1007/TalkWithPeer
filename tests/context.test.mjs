import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.mjs";
import { ContextManager } from "../server/context.mjs";
import { DiscussionEngine } from "../server/engine.mjs";

test("platform checkpoint preserves source records, current turn and member memo isolation", async () => {
  const store = new Store(":memory:");
  try {
    const c = store.createConversation();
    const a = store.addMember(c.id, { name: "A" }),
      b = store.addMember(c.id, { name: "B" });
    store.addMessage(c.id, {
      author: "user",
      kind: "user",
      content: "早期约束".repeat(1000),
    });
    store.addMessage(c.id, {
      author: a.id,
      authorName: "A",
      content: "观点".repeat(500),
    });
    const latest = store.addMessage(c.id, {
      author: "user",
      kind: "user",
      content: "继续讨论",
    });
    const engine = new DiscussionEngine(store, { managedContext: true });
    const context = new ContextManager(store);
    context.addNote(c.id, { text: "共享约束" });
    context.addNote(c.id, { text: "A私有", memberId: a.id });
    context.addNote(c.id, { text: "B私有", memberId: b.id });
    const snapshot = engine.snapshot(c.id, [a, b]);
    const ids = snapshot.history.slice(0, 2).map((m) => m.id);
    await context.compact(snapshot, {
      async run() {
        return {
          text: JSON.stringify({
            summary: "目标与早期约束",
            sourceIds: [ids[0]],
          }),
          model: "model",
        };
      },
    });
    const view = context.project(snapshot, a.id);
    assert.equal(store.messages(c.id).length, 3);
    assert.deepEqual(
      view.history.map((m) => m.id),
      [latest.id],
    );
    assert.deepEqual(view.checkpoint.sourceIds, ids);
    assert.deepEqual(
      view.memo.map((n) => n.text),
      ["共享约束", "A私有"],
    );
    const before = context.state(c.id);
    store.addMessage(c.id, { author: "user", content: "下个轮次" });
    await assert.rejects(
      context.compact(engine.snapshot(c.id, [a, b]), {
        async run() {
          return {
            text: JSON.stringify({
              summary: "虚构来源",
              sourceIds: ["invented"],
            }),
          };
        },
      }),
      /校验/,
    );
    assert.deepEqual(context.state(c.id), before);
    assert.throws(() => context.configure(c.id, { budget: 1 }));
  } finally {
    store.close();
  }
});
test("managed participants receive platform context and preserve platform session through failure", async () => {
  const store = new Store(":memory:");
  const c = store.createConversation(),
    member = store.addMember(c.id, {
      name: "A",
      providerId: "fixture",
      model: "model",
    });
  const inputs = [];
  let fail = false;
  const registry = {
    managedContext: true,
    validateMember() {},
    closeMember() {},
    async driver() {
      return {
        async run(prompt) {
          inputs.push(prompt);
          if (fail) throw new Error("连接中断");
          const candidateId = prompt.match(/"candidateId":"([^"]+)"/)?.[1];
          return {
            text: JSON.stringify(
              candidateId
                ? {
                    message: "接受",
                    candidateId,
                    stance: "accept",
                    acceptsSolution: true,
                    proposal: null,
                    disagreements: [],
                  }
                : { message: "观点", proposal: "方案" },
            ),
            model: "model",
            sessionId: "remote-session",
          };
        },
      };
    },
  };
  const engine = new DiscussionEngine(store, registry);
  try {
    await engine.start(c.id, "第一轮");
    const session = store.member(member.id).localSession;
    assert.notEqual(session, "remote-session");
    await engine.start(c.id, "第二轮");
    assert.equal(store.member(member.id).localSession, session);
    assert.equal(store.member(member.id).remoteSession, "remote-session");
    assert.ok(inputs[2].includes("第一轮"));
    assert.ok(inputs[2].includes('"syncMode":"platform"'));
    fail = true;
    await engine.start(c.id, "第三轮");
    assert.equal(store.conversation(c.id).status, "paused");
    assert.equal(store.member(member.id).localSession, session);
    assert.equal(
      store.messages(c.id).filter((m) => m.kind === "result").length,
      2,
    );
  } finally {
    await engine.close();
    store.close();
  }
});
test("budget overflow compacts old turns and never truncates current constraints", async () => {
  const store = new Store(":memory:");
  const c = store.createConversation();
  const member = store.addMember(c.id, {
    name: "Peer",
    providerId: "fixture",
    model: "model",
  });
  const old = store.addMessage(c.id, {
    author: "user",
    content: "旧约束".repeat(5000),
  });
  let compactions = 0;
  const registry = {
    validateMember() {},
    closeMember() {},
    async driver() {
      return {
        async run(prompt) {
          if (prompt.startsWith("为共享讨论压缩")) {
            compactions++;
            return {
              text: JSON.stringify({
                summary: "保留旧约束",
                sourceIds: [old.id],
              }),
              model: "model",
            };
          }
          const candidateId = prompt.match(/"candidateId":"([^"]+)"/)?.[1];
          assert.ok(prompt.includes("当前完整约束"));
          return {
            text: JSON.stringify(
              candidateId
                ? {
                    message: "接受",
                    candidateId,
                    stance: "accept",
                    acceptsSolution: true,
                    proposal: null,
                    disagreements: [],
                  }
                : { message: "观点", proposal: "方案" },
            ),
            model: "model",
          };
        },
      };
    },
  };
  const engine = new DiscussionEngine(store, registry);
  try {
    engine.context.configure(c.id, { budget: 4000 });
    await engine.start(c.id, "当前完整约束");
    assert.equal(compactions, 1);
    assert.equal(store.conversation(c.id).status, "consensus");
    assert.equal(store.messages(c.id)[0].content.length, 15000);
    assert.ok(
      engine.context
        .project(engine.snapshot(c.id, [member]), member.id)
        .history.some((m) => m.content === "当前完整约束"),
    );
    engine.context.configure(c.id, { auto: false });
    await engine.start(c.id, "当前完整约束".repeat(1700));
    assert.equal(store.conversation(c.id).status, "paused");
    assert.ok(
      store
        .messages(c.id)
        .some((m) => m.content === "当前完整约束".repeat(1700)),
    );
  } finally {
    await engine.close();
    store.close();
  }
});
