import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.mjs";
import { DiscussionEngine } from "../server/engine.mjs";
const setup = (mode) => {
  const store = new Store(":memory:");
  const c = store.createConversation();
  const members = ["A", "B", "C"].map((name) =>
    store.addMember(c.id, {
      name,
      providerId: "codex",
      model: "model",
      parameters: {},
    }),
  );
  const calls = [];
  const registry = {
    validateMember() {},
    closeMember() {},
    async driver(member) {
      return {
        sessionId: "native-" + member.id,
        async run(prompt, _delta, _activity, signal) {
          calls.push({ id: member.id, prompt });
          if (signal.aborted) throw new Error("cancelled");
          const candidateId = prompt.includes("请提出独立观点")
            ? undefined
            : [...prompt.matchAll(/"candidateId":"([^"]+)"/g)].at(-1)?.[1];
          if (!candidateId)
            return {
              text: JSON.stringify({
                message: member.name + " 的公开观点",
                proposal: "共享上下文",
              }),
              sessionId: "native-" + member.id,
              model: "model",
            };
          if (mode === "error" && member.name === "B")
            return {
              text: "not JSON",
              sessionId: "native-" + member.id,
              model: "model",
            };
          const conflict =
            mode === "deadlock" && ["A", "B"].includes(member.name);
          const other = members.find(
            (m) => m.name === (member.name === "A" ? "B" : "A"),
          );
          return {
            text: JSON.stringify({
              message: member.name + " 的判断",
              candidateId,
              stance: conflict ? "reject" : "accept",
              acceptsSolution: !conflict,
              proposal: null,
              disagreements: conflict
                ? [
                    {
                      memberId: other.id,
                      reason: member.name + " 保留不可让步立场",
                      nonNegotiable: true,
                    },
                  ]
                : [],
            }),
            sessionId: "native-" + member.id,
            model: "model",
          };
        },
      };
    },
  };
  return {
    store,
    c,
    members,
    calls,
    engine: new DiscussionEngine(store, registry),
  };
};
test("orchestration records unanimous result and separate sessions", async () => {
  const s = setup("agree");
  try {
    await s.engine.start(s.c.id, "如何共享记录？");
    const c = s.store.conversation(s.c.id);
    assert.equal(c.status, "consensus");
    assert.equal(c.result.votes.length, 3);
    assert.ok(s.store.members(c.id).every((m) => m.localSession));
    assert.equal(
      s.store.messages(c.id).filter((m) => m.kind === "result").length,
      1,
    );
    assert.ok(s.calls[3].prompt.includes("A 的公开观点"));
  } finally {
    s.store.close();
  }
});
test("mutual holdout becomes deadlock after two review rounds", async () => {
  const s = setup("deadlock");
  try {
    await s.engine.start(s.c.id, "讨论分歧");
    const c = s.store.conversation(s.c.id);
    assert.equal(c.status, "deadlock");
    assert.equal(c.result.round, 2);
    assert.equal(c.result.positions.length, 2);
  } finally {
    s.store.close();
  }
});
test("invalid judgments pause without fabricating consensus", async () => {
  const s = setup("error");
  try {
    await s.engine.start(s.c.id, "讨论结果");
    assert.equal(s.store.conversation(s.c.id).status, "paused");
    assert.equal(
      s.store.messages(s.c.id).filter((m) => m.kind === "result").length,
      0,
    );
  } finally {
    s.store.close();
  }
});
test("shared records are complete regardless of native cursor state", async () => {
  const s = setup("agree");
  try {
    s.store.addMessage(s.c.id, {
      author: "user",
      kind: "user",
      content: "必须保留的早期约束".repeat(5000),
    });
    const full = s.engine.snapshot(s.c.id, s.members);
    assert.ok(full.history[0].content.length > 32000);
    assert.equal(
      s.engine.memberSnapshot(full, s.members[0]).syncMode,
      "platform",
    );
    s.store.patchMember(s.members[0].id, {
      localSession: "native",
      lastSyncedMessageId: full.lastMessageId,
    });
    s.store.addMessage(s.c.id, {
      author: "user",
      kind: "user",
      content: "新消息",
    });
    const next = s.engine.memberSnapshot(
      s.engine.snapshot(s.c.id, s.members),
      s.members[0],
    );
    assert.equal(next.syncMode, "platform");
    assert.equal(next.history.length, 2);
    assert.equal(next.history[1].content, "新消息");
    s.store.patchMember(s.members[0].id, { localSession: null });
    assert.equal(
      s.engine.memberSnapshot(
        s.engine.snapshot(s.c.id, s.members),
        s.members[0],
      ).history.length,
      2,
    );
  } finally {
    s.store.close();
  }
});
test("stopping an in-flight request pauses and keeps shared records", async () => {
  const store = new Store(":memory:");
  const c = store.createConversation();
  store.addMember(c.id, {
    name: "Peer",
    providerId: "provider",
    model: "model",
    parameters: {},
  });
  let started;
  const ready = new Promise((resolve) => (started = resolve));
  const registry = {
    validateMember() {},
    closeMember() {},
    async driver() {
      return {
        sessionId: "pending-session",
        async run(_prompt, _delta, _activity, signal) {
          started();
          await new Promise((resolve) =>
            signal.addEventListener("abort", resolve, { once: true }),
          );
          throw new Error("cancelled");
        },
      };
    },
  };
  const engine = new DiscussionEngine(store, registry);
  try {
    const task = engine.start(c.id, "保留这个问题");
    await ready;
    engine.stop(c.id);
    await task;
    assert.equal(store.conversation(c.id).status, "paused");
    assert.equal(store.messages(c.id)[0].content, "保留这个问题");
    assert.ok(store.messages(c.id).some((m) => m.status === "interrupted"));
    assert.equal(
      store.messages(c.id).filter((m) => m.kind === "result").length,
      0,
    );
  } finally {
    await engine.close();
    store.close();
  }
});
