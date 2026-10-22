import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CodexAdapter } from "../server/native-adapters.mjs";
import { DiscussionEngine } from "../server/engine.mjs";
import { Store } from "../server/store.mjs";

function codexFixture() {
  const rpc = new EventEmitter();
  const adapter = new CodexAdapter(process.cwd());
  let start;
  const started = new Promise((resolve) => (start = resolve));
  rpc.closed = false;
  rpc.call = async (method) => {
    assert.equal(method, "turn/start");
    start();
    return {};
  };
  rpc.stop = () => {
    rpc.closed = true;
    rpc.emit("closed", new Error("fixture connection closed"));
  };
  adapter.connect = async () => {
    adapter.rpc = rpc;
    adapter.sessionId = "fixture-thread";
  };
  const emit = (method, params) =>
    rpc.emit("message", {
      method,
      params: { threadId: "fixture-thread", ...params },
    });
  return { adapter, rpc, started, emit };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("Codex can complete a progressing turn after 120 seconds within the platform allowance", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = codexFixture();
  const deltas = [], activities = [];
  const pending = s.adapter.run(
    "fixture",
    (text) => deltas.push(text),
    (activity) => activities.push(activity),
    new AbortController().signal,
  );
  let failure, reply;
  pending.then((value) => (reply = value), (error) => (failure = error));
  try {
    await s.started;
    t.mock.timers.tick(100000);
    s.emit("item/reasoning/summaryTextDelta", { delta: "fixture activity" });
    s.emit("item/agentMessage/delta", { delta: "partial" });
    t.mock.timers.tick(30000);
    await flush();
    assert.equal(
      failure,
      undefined,
      "120s must not cut off an allowed Codex turn",
    );
    assert.equal(reply, undefined);
    assert.equal(s.rpc.closed, false);
    assert.deepEqual(deltas, ["partial"]);
    assert.ok(activities.some((a) => a.type === "reasoning-summary"));
    s.emit("item/completed", {
      item: {
        id: "final",
        type: "agentMessage",
        phase: "final_answer",
        text: "final answer",
      },
    });
    s.emit("turn/completed", { turn: { status: "completed" } });
    assert.equal((await pending).text, "final answer");
    t.mock.timers.tick(60000);
    assert.equal(
      s.rpc.closed,
      false,
      "successful completion clears the native deadline",
    );
  } finally {
    s.adapter.close();
    await pending.catch(() => {});
  }
});

test("the engine still interrupts a real Codex adapter at 180 seconds without a final vote", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = codexFixture(),
    store = new Store(":memory:");
  const c = store.createConversation();
  store.addMember(c.id, {
    name: "fixture",
    providerId: "codex",
    model: "model",
    parameters: {},
  });
  const engine = new DiscussionEngine(store, {
    validateMember() {},
    driver: async () => s.adapter,
    closeMember: () => s.adapter.close(),
  });
  const pending = engine.start(c.id, "fixture");
  try {
    await s.started;
    t.mock.timers.tick(100000);
    s.emit("item/agentMessage/delta", { delta: "partial, not a final answer" });
    t.mock.timers.tick(30000);
    await flush();
    assert.equal(store.conversation(c.id).status, "running");
    assert.equal(s.rpc.closed, false);
    t.mock.timers.tick(50000);
    await pending;
    const request = store.requests(c.id).at(-1);
    assert.equal(request.status, "interrupted");
    assert.equal(request.errorCode, "agent_timeout");
    assert.equal(request.error, "本轮 Agent 请求超过时间限制。");
    assert.equal(s.rpc.closed, true);
    assert.equal(store.conversation(c.id).status, "paused");
    assert.equal(store.conversation(c.id).result, null);
    assert.ok(
      !store.messages(c.id).some(
        (m) => m.kind === "result" || m.kind === "judgment",
      ),
    );
  } finally {
    await engine.close();
    await pending;
    store.close();
  }
});
