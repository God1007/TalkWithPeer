import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.mjs";
import { createApp } from "../server/index.mjs";
import { Terminal, connectLocal, help, commands } from "../bin/twp.mjs";

test("logs paginate after filtering, survive restart and exclude payloads and credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "twp-logs-"));
  const file = path.join(root, "state.sqlite");
  let store = new Store(file);
  try {
    const c = store.createConversation();
    const request = {
      id: "model-request",
      conversationId: c.id,
      createdAt: new Date().toISOString(),
      phase: "opinion",
      model: "fixture",
      status: "pending",
      input: "PRIVATE_PROMPT",
    };
    store.saveRequest(request);
    store.saveExtensionRun({
      id: "tool-run",
      type: "tool",
      requestId: request.id,
      conversationId: c.id,
      createdAt: request.createdAt,
      status: "pending",
      arguments: { query: "PRIVATE_QUERY" },
    });
    for (let i = 0; i < 205; i++)
      store.log({
        category: "http",
        action: "request.finished",
        message: "other",
      });
    const first = store.logs({ conversationId: c.id, limit: 1 });
    assert.equal(first.logs[0].executionId, "tool-run");
    const second = store.logs({
      conversationId: c.id,
      limit: 1,
      before: first.nextBefore,
    });
    assert.equal(second.logs[0].requestId, request.id);
    assert.equal(second.nextBefore, null);
    const secret = store.log({
      category: "service",
      action: "error",
      level: "error",
      error: "api_key=sk-secret Bearer secret",
      body: "PRIVATE_BODY",
      headers: { authorization: "PRIVATE_HEADER" },
    });
    assert.ok(secret.error.includes("已隐藏凭证"));
    const logs = JSON.stringify(store.logs({ limit: 100 }));
    assert.ok(!/sk-secret|PRIVATE_BODY|PRIVATE_HEADER/.test(logs));
    assert.ok(
      !/PRIVATE_PROMPT|PRIVATE_QUERY/.test(
        JSON.stringify(store.logs({ conversationId: c.id })),
      ),
    );
    assert.throws(() => store.logs({ before: 0 }), /参数/);
    assert.throws(() => store.logs({ limit: 101 }), /参数/);
    assert.throws(() => store.logs({ category: "' OR 1=1" }), /参数/);
    const oldServiceId = store.serviceId;
    store.log({
      category: "service",
      action: "server.started",
      message: "fixture start",
    });
    store.close();
    store = new Store(file);
    const recovered = store.logs({ requestId: request.id }).logs;
    assert.ok(
      recovered.some(
        (r) => r.category === "model" && r.status === "interrupted",
      ),
    );
    assert.ok(
      recovered.some(
        (r) => r.category === "extension" && r.status === "interrupted",
      ),
    );
    assert.ok(recovered.some((r) => r.serviceId === oldServiceId));
    assert.notEqual(store.serviceId, oldServiceId);
    assert.ok(
      store
        .logs({ category: "service" })
        .logs.some(
          (r) =>
            r.action === "server.prior-exit-unconfirmed" &&
            r.previousServiceId === oldServiceId,
        ),
    );
    const other = store.createConversation();
    for (let i = 0; i < 205; i++)
      store.saveExtensionRun({
        id: "other-" + i,
        conversationId: other.id,
        type: "tool",
        createdAt: new Date().toISOString(),
        status: "complete",
      });
    assert.equal(store.extensionRuns(c.id).length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("backend logs persist HTTP metadata without Web or terminal access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "twp-log-http-"));
  const registry = {
    refresh: async () => [],
    list: () => [],
    close() {},
    closeMember() {},
  };
  const app = await createApp({ root, registry });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + app.server.address().port;
  let connection;
  try {
    assert.equal((await fetch(origin + "/api/logs")).status, 401);
    connection = await connectLocal(app.server.address().port);
    const created = await connection.request("/conversations", "POST", {
      title: "PRIVATE_BODY",
    });
    const cookieResponse = await fetch(origin + "/api/session", {
      method: "POST",
      headers: {
        "X-TWP": "1",
        "Content-Type": "application/json",
        Origin: origin,
      },
      body: "{}",
    });
    const cookie = cookieResponse.headers.get("set-cookie").split(";")[0];
    const bad = await fetch(
      origin + "/api/not-found-secret?token=QUERY_SECRET",
      { headers: { cookie } },
    );
    assert.equal(bad.status, 404);
    const requestId = bad.headers.get("x-request-id");
    const httpLogs = app.store.logs({ category: "http" }).logs;
    assert.ok(
      httpLogs.some(
        (r) =>
          r.httpRequestId === requestId &&
          r.statusCode === 404 &&
          r.route === "/api/:id",
      ),
    );
    assert.ok(httpLogs.some((r) => r.client === "cli" && r.statusCode === 201));
    assert.ok(
      !/PRIVATE_BODY|QUERY_SECRET|not-found-secret/.test(
        JSON.stringify(httpLogs),
      ),
    );
    const count = app.store.logs().logs.length;
    await connection.request("/bootstrap");
    await connection.request("/bootstrap");
    assert.equal(app.store.logs().logs.length, count);
    const output = [];
    const terminal = new Terminal(connection.request, (line) =>
      output.push(line),
    );
    terminal.id = created.conversation.id;
    await assert.rejects(terminal.execute("/logs"), /未知命令/);
    assert.equal(output.length, 0);
    assert.equal(commands.logs, undefined);
    assert.ok(!/^\/logs /m.test(help));
    await assert.rejects(connection.request("/logs"), /接口不存在/);
    await assert.rejects(
      connection.request("/logs?category=http"),
      /接口不存在/,
    );
    assert.ok(
      app.store
        .logs({ category: "service" })
        .logs.some((r) => r.action === "server.started"),
    );
  } finally {
    await connection?.close();
    await app.close();
  }
  const reopened = new Store(path.join(root, "workspace.sqlite"));
  assert.ok(
    reopened
      .logs({ category: "service" })
      .logs.some((r) => r.action === "server.stopped"),
  );
  assert.ok(
    !reopened
      .logs({ category: "service" })
      .logs.some((r) => r.action === "server.prior-exit-unconfirmed"),
  );
  reopened.close();
  await rm(root, { recursive: true, force: true });
});
