import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.mjs";
import {
  ContextManager,
  hashInput,
  validateCapacity,
} from "../server/context.mjs";
import { DiscussionEngine } from "../server/engine.mjs";

const summary = (prompt) => {
  const { messages } = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
  return {
    text: JSON.stringify({
      summary: "有来源的陈述，保留未决问题。",
      facts: messages.map((message) => ({
        text: "历史陈述",
        sourceId: message.id,
        quote: message.content.slice(0, 40),
      })),
      decisions: [],
      unresolved: [],
    }),
    model: "model",
  };
};
const answer = (prompt) => {
  const candidateId = prompt.includes("请提出独立观点")
    ? null
    : [...prompt.matchAll(/"candidateId":"([^"]+)"/g)].at(-1)?.[1];
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
};
const setup = () => {
  const store = new Store(":memory:"),
    c = store.createConversation();
  const a = store.addMember(c.id, {
    name: "用户",
    providerId: "fixture",
    model: "model",
    parameters: {},
  });
  const b = store.addMember(c.id, {
    name: "Peer",
    providerId: "fixture",
    model: "model",
    parameters: {},
  });
  const engine = new DiscussionEngine(store, {
    validateMember() {},
    closeMember() {},
    async driver() {
      return {
        async run(prompt) {
          return prompt.startsWith("为共享讨论压缩")
            ? summary(prompt)
            : answer(prompt);
        },
      };
    },
  });
  return {
    store,
    c,
    a,
    b,
    engine,
    context: engine.context,
    snapshot: () => engine.snapshot(c.id, [a, b]),
  };
};
test("provider-disclosed summaries are coalesced and never added to shared model history", async () => {
  const s = setup();
  s.store.patchMember(s.b.id, { active: false });
  s.engine.registry.driver = async () => ({
    async run(prompt, _delta, activity) {
      activity({ type: "reasoning-summary", text: "公开" });
      activity({ type: "reasoning-summary", text: "解释" });
      return answer(prompt);
    },
  });
  try {
    await s.engine.start(s.c.id, "问题");
    const summaries = s.store
      .events(s.c.id)
      .filter((e) => e.type === "reasoning-summary");
    assert.equal(summaries.length, 2);
    assert.ok(summaries.every((e) => e.summary === "公开解释"));
    assert.ok(
      !s.engine
        .snapshot(s.c.id, [s.a])
        .history.some((m) => m.content === "公开解释"),
    );
  } finally {
    await s.engine.close();
    s.store.close();
  }
});
test("provider overflow replays the entire frozen phase once and never counts superseded votes", async () => {
  const s = setup();
  s.store.addMessage(s.c.id, { author: "user", content: "目标" });
  s.store.addMessage(s.c.id, {
    author: s.a.id,
    content: "早期观点".repeat(500),
  });
  let overflow = true,
    failures = 0;
  s.engine.registry.driver = async (member) => ({
    async run(prompt) {
      if (prompt.startsWith("为共享讨论压缩")) return summary(prompt);
      if (
        member.id === s.b.id &&
        prompt.includes("请提出独立观点") &&
        overflow
      ) {
        failures++;
        overflow = false;
        throw Object.assign(new Error("actual model context exceeded"), {
          code: "context_overflow",
        });
      }
      return answer(prompt);
    },
  });
  try {
    await s.engine.start(s.c.id, "继续");
    assert.equal(s.store.conversation(s.c.id).status, "consensus");
    assert.equal(failures, 1);
    assert.ok(s.store.messages(s.c.id).some((m) => m.status === "superseded"));
    assert.equal(
      s.store.events(s.c.id).filter((e) => e.type === "recovery").length,
      1,
    );
    assert.ok(
      s.store.requests(s.c.id).some((r) => r.errorCode === "context_overflow"),
    );
  } finally {
    await s.engine.close();
    s.store.close();
  }
});
test("repeated real overflows stop after one recovery; output exhaustion never masquerades as a format retry", async () => {
  const s = setup();
  s.store.patchMember(s.b.id, { active: false });
  s.store.addMessage(s.c.id, { author: "user", content: "目标" });
  s.store.addMessage(s.c.id, {
    author: s.a.id,
    content: "早期观点".repeat(500),
  });
  let failedRuns = 0;
  s.engine.registry.driver = async () => ({
    async run(prompt) {
      if (prompt.startsWith("为共享讨论压缩")) return summary(prompt);
      failedRuns++;
      throw Object.assign(new Error("window"), { code: "context_overflow" });
    },
  });
  try {
    await s.engine.start(s.c.id, "继续");
    assert.equal(failedRuns, 2);
    assert.equal(s.store.conversation(s.c.id).status, "paused");
    assert.equal(
      s.store.messages(s.c.id).filter((m) => m.kind === "result").length,
      0,
    );
    failedRuns = 0;
    s.engine.registry.driver = async () => ({
      async run() {
        failedRuns++;
        throw Object.assign(new Error("output"), { code: "output_limit" });
      },
    });
    await s.engine.start(s.c.id, "继续");
    assert.equal(failedRuns, 1);
    assert.equal(s.store.conversation(s.c.id).status, "paused");
  } finally {
    await s.engine.close();
    s.store.close();
  }
});
test("exact counters and measured usage calibrate estimates without hiding their origin", async () => {
  const s = setup();
  try {
    const providerCount = await s.context.measure(s.c.id, s.a, "text", {
      countTokens: async () => 42,
    });
    assert.deepEqual(providerCount, { tokens: 42, method: "provider" });
    const before = await s.context.measure(s.c.id, s.a, "abcdef", {});
    s.context.observe(s.a, "abcdef", { prompt_tokens: 100 });
    const after = await s.context.measure(s.c.id, s.a, "abcdef", {});
    assert.equal(after.method, "calibrated-estimate");
    assert.ok(after.tokens > before.tokens);
    s.context.configureTask(s.c.id, {
      goal: "新的明确任务",
      constraints: ["新约束"],
      rebase: true,
    });
    assert.equal(s.context.state(s.c.id).task.revision, 1);
    assert.throws(() => s.context.configureTask(s.c.id, { constraints: [""] }));
  } finally {
    s.store.close();
  }
});
test("repeated compaction preserves exact user directives, task constraints and stable roles", async () => {
  const s = setup();
  try {
    s.store.addMessage(s.c.id, {
      author: "user",
      content: "目标：保留所有原始记录",
    });
    s.store.addMessage(s.c.id, {
      author: "user",
      content: "禁止把未解决分歧写成决定",
    });
    const old = s.store.addMessage(s.c.id, {
      author: s.a.id,
      authorName: "用户",
      content: "长观点".repeat(4000),
    });
    s.store.addMessage(s.c.id, { author: "user", content: "继续第一轮" });
    s.context.configureTask(s.c.id, {
      constraints: ["必须带来源", "不能写文件"],
    });
    s.context.addNote(s.c.id, { text: "共享 memo" });
    s.context.addNote(s.c.id, { text: "A私有", memberId: s.a.id });
    s.context.addNote(s.c.id, { text: "B私有", memberId: s.b.id });
    await s.context.compact(
      s.snapshot(),
      { run: async (prompt) => summary(prompt) },
      undefined,
      { member: s.a },
    );
    const first = s.context.project(s.snapshot(), s.a.id);
    assert.ok(first.task.goal.text.includes("保留所有原始记录"));
    assert.ok(
      first.task.directives.some(
        (m) => m.content === "禁止把未解决分歧写成决定",
      ),
    );
    assert.deepEqual(
      first.task.constraints.map((c) => c.text),
      ["必须带来源", "不能写文件"],
    );
    assert.deepEqual(
      first.memo.map((n) => n.text),
      ["共享 memo", "A私有"],
    );
    assert.equal(
      s.snapshot().history.find((m) => m.id === old.id).role,
      "agent",
    );
    assert.ok(!first.history.some((m) => m.id === old.id));
    const originalLength = s.store.messages(s.c.id).length;
    s.store.addMessage(s.c.id, {
      author: s.a.id,
      authorName: "用户",
      content: "再次长观点".repeat(1000),
    });
    s.store.addMessage(s.c.id, { author: "user", content: "继续第二轮" });
    await s.context.compact(
      s.snapshot(),
      { run: async (prompt) => summary(prompt) },
      undefined,
      { member: s.a },
    );
    assert.equal(s.context.state(s.c.id).checkpoints.length, 2);
    assert.equal(s.store.messages(s.c.id).length, originalLength + 2);
    assert.ok(
      s.context
        .project(s.snapshot())
        .task.directives.some((m) => m.content === "禁止把未解决分歧写成决定"),
    );
    assert.equal(
      s.context.project(s.snapshot()).task.latestRequestId,
      s.store.messages(s.c.id).findLast((m) => m.author === "user").id,
    );
    assert.deepEqual(
      s.context.readEvidence(s.c.id, [old.id])[0].content,
      old.content,
    );
    assert.throws(
      () => s.context.readEvidence(s.c.id, ["foreign-id"]),
      /不存在/,
    );
  } finally {
    s.store.close();
  }
});
test("checkpoint rejects fabricated quotes and unconfirmed decisions without replacing old state", async () => {
  const s = setup();
  try {
    s.store.addMessage(s.c.id, { author: "user", content: "任务" });
    const old = s.store.addMessage(s.c.id, {
      author: s.a.id,
      content: "仅为建议".repeat(1000),
    });
    s.store.addMessage(s.c.id, { author: "user", content: "继续" });
    const before = s.context.state(s.c.id);
    for (const fabricated of [true, false]) {
      await assert.rejects(
        s.context.compact(
          s.snapshot(),
          {
            async run() {
              return {
                text: JSON.stringify({
                  summary: "候选已决定",
                  facts: fabricated
                    ? [
                        {
                          text: "事实",
                          sourceId: old.id,
                          quote: "不存在的引文",
                        },
                      ]
                    : [],
                  decisions: fabricated
                    ? []
                    : [{ text: "决定", sourceId: old.id, quote: "仅为建议" }],
                  unresolved: [],
                }),
              };
            },
          },
          undefined,
          { member: s.a },
        ),
        /摘要引用/,
      );
      assert.deepEqual(s.context.state(s.c.id), before);
    }
  } finally {
    s.store.close();
  }
});
test("current-round compaction preserves latest member replies, user instruction and canonical vote", async () => {
  const s = setup();
  try {
    s.store.addMessage(s.c.id, { author: "user", content: "当前任务不能改写" });
    const old = s.store.addMessage(s.c.id, {
      author: s.a.id,
      content: "过时互评".repeat(3000),
    });
    const lastA = s.store.addMessage(s.c.id, {
      author: s.a.id,
      kind: "judgment",
      content: "仍然反对",
      judgment: {
        candidateId: "candidate",
        stance: "reject",
        acceptsSolution: false,
        disagreements: [
          { memberId: s.b.id, reason: "不能让步", nonNegotiable: true },
        ],
      },
    });
    const lastB = s.store.addMessage(s.c.id, {
      author: s.b.id,
      kind: "judgment",
      content: "最新理由",
      judgment: {
        candidateId: "candidate",
        stance: "accept",
        acceptsSolution: true,
        disagreements: [],
      },
    });
    s.store.patchConversation(s.c.id, {
      candidate: { id: "candidate", text: "候选", revision: 1 },
    });
    await s.context.compact(
      s.snapshot(),
      { run: async (prompt) => summary(prompt) },
      undefined,
      { member: s.a },
    );
    const input = s.context.project(s.snapshot());
    assert.ok(input.history.some((m) => m.id === lastA.id));
    assert.ok(input.history.some((m) => m.id === lastB.id));
    assert.ok(!input.history.some((m) => m.id === old.id));
    assert.equal(
      input.discussionState.latestJudgments[0].disagreements[0].nonNegotiable,
      true,
    );
    assert.equal(input.task.goal.text, "当前任务不能改写");
  } finally {
    s.store.close();
  }
});
test("capacity deducts output and explicit extra reservations without assuming unknown windows", () => {
  const s = setup();
  try {
    assert.equal(s.context.capacity(s.c.id, s.a).windowSource, "unknown");
    const capacity = s.context.capacity(s.c.id, {
      ...s.a,
      parameters: { outputTokens: 2048 },
      capacity: { windowTokens: 8192, extraReserve: 1024, safetyReserve: 512 },
    });
    assert.equal(capacity.inputLimit, 4608);
    assert.equal(capacity.outputReserve, 2048);
    const clamped = s.context.capacity(
      s.c.id,
      { ...s.a, capacity: { windowTokens: 16384 } },
      { windowTokens: 8192 },
    );
    assert.equal(clamped.windowTokens, 8192);
    assert.equal(clamped.windowSource, "provider");
    assert.equal(
      s.context.capacity(
        s.c.id,
        { ...s.a, capacity: { windowTokens: null } },
        { windowTokens: 8192 },
      ).windowTokens,
      8192,
    );
    assert.throws(() => validateCapacity({ windowTokens: -1 }));
    assert.throws(() =>
      s.context.capacity(s.c.id, { ...s.a, capacity: { windowTokens: 1024 } }),
    );
  } finally {
    s.store.close();
  }
});
test("automatic budget compaction handles long agent history but refuses to discard oversized user instructions", async () => {
  const s = setup();
  try {
    s.store.addMessage(s.c.id, { author: "user", content: "必须保留原文" });
    s.store.addMessage(s.c.id, {
      author: s.a.id,
      content: "旧观点".repeat(5000),
    });
    s.context.configure(s.c.id, { budget: 4000 });
    await s.engine.start(s.c.id, "当前完整约束");
    assert.equal(s.store.conversation(s.c.id).status, "consensus");
    assert.equal(s.context.state(s.c.id).checkpoints.length, 1);
    assert.ok(
      s.context.project(s.snapshot()).task.goal.text.includes("必须保留原文"),
    );
    const session = s.store.member(s.a.id).localSession;
    s.context.configure(s.c.id, { auto: false });
    await s.engine.start(s.c.id, "当前完整约束".repeat(1700));
    assert.equal(s.store.conversation(s.c.id).status, "paused");
    assert.equal(s.store.member(s.a.id).localSession, session);
    assert.ok(
      s.store
        .messages(s.c.id)
        .some((m) => m.content === "当前完整约束".repeat(1700)),
    );
  } finally {
    await s.engine.close();
    s.store.close();
  }
});
test("agent evidence loop is bounded, audited and only reads public records in its conversation", async () => {
  const s = setup();
  s.store.patchMember(s.b.id, { active: false });
  const original = s.store.addMessage(s.c.id, {
    author: s.a.id,
    content: "原始证据",
  });
  let reads = 0;
  s.engine.registry.driver = async () => ({
    async run(prompt) {
      if (
        !prompt.includes('"evidence":') &&
        prompt.includes("请提出独立观点")
      ) {
        reads++;
        return { text: JSON.stringify({ readMessageIds: [original.id] }) };
      }
      assert.ok(prompt.includes("原始证据"));
      return answer(prompt);
    },
  });
  try {
    await s.engine.start(s.c.id, "核对旧证据");
    assert.equal(s.store.conversation(s.c.id).status, "consensus");
    assert.equal(reads, 1);
    const records = s.store.requests(s.c.id);
    assert.ok(records.some((r) => r.status === "evidence-request"));
    assert.ok(records.some((r) => r.evidenceIds.includes(original.id)));
    for (const metadata of records)
      assert.equal(
        hashInput(s.store.request(metadata.id).input),
        metadata.inputHash,
      );
    const other = s.store.createConversation();
    const foreign = s.store.addMessage(other.id, {
      author: "user",
      content: "外部记录",
    });
    assert.throws(() => s.context.readEvidence(s.c.id, [foreign.id]));
    s.engine.registry.driver = async () => ({
      async run() {
        return { text: JSON.stringify({ readMessageIds: [original.id] }) };
      },
    });
    await s.engine.start(s.c.id, "无限回取");
    assert.equal(s.store.conversation(s.c.id).status, "paused");
    assert.equal(
      s.store.messages(s.c.id).filter((m) => m.kind === "result").length,
      1,
    );
  } finally {
    await s.engine.close();
    s.store.close();
  }
});
test("platform sessions and frozen public input hashes survive repeated requests and failure", async () => {
  const s = setup();
  try {
    await s.engine.start(s.c.id, "第一轮");
    const session = s.store.member(s.a.id).localSession;
    await s.engine.start(s.c.id, "第二轮");
    assert.equal(s.store.member(s.a.id).localSession, session);
    assert.equal(s.store.conversation(s.c.id).status, "consensus");
    assert.equal(
      s.store.conversation(s.c.id).result.requestSourceId,
      s.store.messages(s.c.id).findLast((m) => m.author === "user").id,
    );
    const opinion = s.store
      .requests(s.c.id)
      .filter((r) => r.phase === "opinion");
    assert.equal(opinion[0].sharedHash, opinion[1].sharedHash);
    assert.equal(opinion[2].sharedHash, opinion[3].sharedHash);
    s.engine.registry.driver = async () => ({
      async run() {
        throw new Error("连接中断");
      },
    });
    await s.engine.start(s.c.id, "第三轮");
    assert.equal(s.store.conversation(s.c.id).status, "paused");
    assert.equal(s.store.member(s.a.id).localSession, session);
    assert.equal(
      s.store.messages(s.c.id).filter((m) => m.kind === "result").length,
      2,
    );
  } finally {
    await s.engine.close();
    s.store.close();
  }
});
