import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function fixture() {
  const source = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
  const start = source.indexOf("function App() {");
  const end = source.indexOf("  const boot = useCallback(", start);
  assert.ok(start >= 0 && end > start);
  const cleanupStart = source.indexOf("    return () => {\n      disposed = true;", end);
  const cleanupEnd = source.indexOf("\n  }, [id, connected, load]);", cleanupStart);
  assert.ok(cleanupStart > end && cleanupEnd > cleanupStart);
  const cleanup = source.slice(cleanupStart + "    return ".length, cleanupEnd);
  const states = new Map(), requests = [];
  const useState = initial => {
    let value = initial;
    const set = update => { value = typeof update === "function" ? update(value) : update; };
    states.set(set, () => value);
    return [value, set];
  };
  // Run the actual App initialization and load callback; only transport and hook storage are controlled.
  const app = new Function("useState", "useRef", "useCallback", "localStorage", "api",
    source.slice(start, end) + "let disposed = false, scheduled; const stream = {close() {}}; const dispose = " + cleanup + "return {load, selectedId, setWorkspace, setBootstrap, dispose}; } return App();")(
    useState, current => ({current}), fn => fn, {getItem: () => "a"}, endpoint => {
      const pending = Promise.withResolvers();
      requests.push({endpoint, ...pending});
      return pending.promise;
    },
  );
  app.setBootstrap({conversations: [snapshot("a", 0).conversation, snapshot("b", 0).conversation]});
  return {...app, requests, workspace: states.get(app.setWorkspace), bootstrap: states.get(app.setBootstrap)};
}

function snapshot(id, revision) {
  return {conversation: {id, contextVersion: revision, status: revision === 2 ? "running" : "paused", updatedAt: String(revision)}, messages: ["message " + revision]};
}

test("an older workspace response cannot roll back newer messages, status or sidebar", async () => {
  const f = await fixture();
  const old = f.load("a"), recent = f.load("a");
  const latest = snapshot("a", 2);
  f.requests[1].resolve(latest);
  await recent;
  f.requests[0].resolve(snapshot("a", 1));
  await old;
  assert.deepEqual(f.workspace(), latest);
  assert.deepEqual(f.bootstrap().conversations[0], latest.conversation);
  const fresh = f.load("a");
  f.requests[2].resolve(snapshot("a", 3));
  await fresh;
  assert.equal(f.workspace().conversation.contextVersion, 3, "later valid refreshes still apply");
});

test("obsolete refresh errors are ignored while the current error reaches the caller", async () => {
  const f = await fixture();
  const old = f.load("a"), recent = f.load("a");
  f.requests[1].resolve(snapshot("a", 2));
  await recent;
  f.requests[0].reject(new Error("obsolete request failed"));
  await assert.doesNotReject(old);
  const current = f.load("a");
  f.requests[2].reject(new Error("current request failed"));
  await assert.rejects(current, /current request failed/);
});

test("an old conversation callback cannot invalidate the current conversation refresh", async () => {
  const f = await fixture();
  const old = f.load("a");
  f.selectedId.current = "b";
  const current = f.load("b");
  const obsolete = f.load("a"); // A mutation started in A may finish after the user has selected B.
  assert.equal(f.requests.length, 2, "do not issue a read for an obsolete target");
  await obsolete;
  f.requests[1].resolve(snapshot("b", 2));
  await current;
  f.requests[0].reject(new Error("old conversation failed"));
  await assert.doesNotReject(old);
  assert.equal(f.workspace().conversation.id, "b");
});

test("returning to a conversation does not revive its earlier pending response", async () => {
  const f = await fixture();
  const oldA = f.load("a");
  f.selectedId.current = "b";
  const readB = f.load("b");
  f.selectedId.current = "a";
  const newA = f.load("a");
  f.requests[2].resolve(snapshot("a", 2));
  await newA;
  f.requests[1].resolve(snapshot("b", 1));
  await readB;
  f.requests[0].resolve(snapshot("a", 1));
  await oldA;
  assert.equal(f.workspace().conversation.contextVersion, 2);
  assert.equal(f.bootstrap().conversations[0].contextVersion, 2);
});

test("subscription cleanup invalidates pending workspace success and failure", async () => {
  const f = await fixture();
  const pending = f.load("a");
  f.dispose(); // The same cleanup runs on conversation change, disconnect and unmount.
  f.requests[0].resolve(snapshot("a", 1));
  await pending;
  assert.equal(f.workspace(), null);
  assert.equal(f.bootstrap().conversations[0].contextVersion, 0);
  const g = await fixture();
  const rejected = g.load("a");
  g.dispose();
  g.requests[0].reject(new Error("request failed after cleanup"));
  await assert.doesNotReject(rejected);
});
