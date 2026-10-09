import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ApiAdapter, discoverApi, apiKey } from "../server/api-adapter.mjs";
import { resolveModel } from "../server/catalog.mjs";
import { mkdtemp, rm, readdir, stat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/store.mjs";
import { AgentRegistry } from "../server/registry.mjs";
import { createApp } from "../server/index.mjs";
import { AGENT_INSTRUCTIONS } from "../shared/agent-instructions.mjs";

test("three stateless API protocols preserve wire format, usage and reject partial output", async () => {
  const requests = [];
  let partial = false;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    requests.push({ url: req.url, headers: req.headers, body });
    let data;
    if (req.url === "/models")
      data = { data: [{ id: "model", context_window: 8192 }] };
    if (["/messages/count_tokens", "/responses/input_tokens"].includes(req.url))
      data = { input_tokens: 512 };
    if (req.url === "/chat/completions")
      data = {
        model: "model",
        choices: [
          {
            finish_reason: partial ? "length" : "stop",
            message: { content: "公开回答", reasoning_content: "private" },
          },
        ],
        usage: { total_tokens: 20 },
      };
    if (req.url === "/responses")
      data = {
        status: partial ? "incomplete" : "completed",
        output: [{ content: [{ type: "output_text", text: "公开回答" }] }],
        usage: { total_tokens: 20 },
      };
    if (req.url === "/messages")
      data = {
        stop_reason: partial ? "max_tokens" : "end_turn",
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "公开回答" },
        ],
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.TWP_FIXTURE_KEY = "fixture-secret";
  try {
    for (const protocol of ["chat", "responses", "messages"]) {
      const provider = await discoverApi({
        name: "Fixture",
        protocol,
        baseUrl: "http://127.0.0.1:" + server.address().port,
        tokenEnv: "TWP_FIXTURE_KEY",
      });
      const config = resolveModel(provider, {
        model: "model",
        parameters: { outputTokens: 2048 },
      });
      assert.throws(() =>
        resolveModel(provider, {
          model: "model",
          parameters: { outputTokens: -1 },
        }),
      );
      const adapter = new ApiAdapter(provider, config);
      assert.equal(provider.models[0].capacity.windowTokens, 8192);
      if (protocol !== "chat") {
        assert.equal(await adapter.countTokens("共享上下文"), 512);
        assert.equal(requests.at(-1).body.model, "model");
        assert.ok(!Object.hasOwn(requests.at(-1).body, "max_tokens"));
        assert.equal(
          protocol === "messages"
            ? requests.at(-1).body.system
            : requests.at(-1).body.instructions,
          AGENT_INSTRUCTIONS,
        );
      }
      const output = await adapter.run(
        "共享上下文",
        () => {},
        () => {},
      );
      assert.equal(output.text, "公开回答");
      assert.ok(output.usage);
      const request = requests.at(-1);
      assert.equal(adapter.inputMetadata().instructions, AGENT_INSTRUCTIONS);
      assert.equal(
        protocol === "messages"
          ? request.body.system
          : protocol === "responses"
            ? request.body.instructions
            : request.body.messages[0].content,
        AGENT_INSTRUCTIONS,
      );
      if (protocol === "chat")
        assert.equal(request.body.messages[0].role, "system");
      assert.equal(request.body.model, "model");
      assert.ok(!JSON.stringify(request.body).includes("previous_response_id"));
      if (protocol === "responses") assert.equal(request.body.store, false);
      if (protocol === "messages")
        assert.equal(request.headers["x-api-key"], "fixture-secret");
      else assert.equal(request.headers.authorization, "Bearer fixture-secret");
      partial = true;
      await assert.rejects(
        adapter.run(
          "共享上下文",
          () => {},
          () => {},
        ),
        /完整/,
      );
      partial = false;
    }
    await assert.rejects(
      apiKey({
        credentialSource: "reasonix",
        baseUrl: "https://evil.example",
        tokenEnv: "DEEPSEEK_API_KEY",
      }),
      /官方/,
    );
  } finally {
    delete process.env.TWP_FIXTURE_KEY;
    await new Promise((resolve) => server.close(resolve));
  }
});
test("HTTP API connection stores keys privately, survives new registry and never returns secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "twp-key-"));
  const key = "local-fixture-credential";
  let fail = false,
    malformed = false,
    receivedKey;
  const upstream = http.createServer(async (req, res) => {
    receivedKey = req.headers.authorization;
    for await (const _ of req) {
    }
    if (fail) {
      res.writeHead(401);
      res.end(key);
      return;
    }
    if (malformed) {
      res.end(key);
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/models"
          ? { data: [{ id: "fixture-model" }] }
          : {
              model: "fixture-model",
              choices: [
                { finish_reason: "stop", message: { content: "公开回答" } },
              ],
            },
      ),
    );
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const store = new Store(":memory:"),
    registry = new AgentRegistry(store, path.join(root, "runtime"));
  registry.refresh = async () => registry.list();
  const app = await createApp({ root, store, registry });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + app.server.address().port;
  try {
    const session = await fetch(origin + "/api/session", {
      method: "POST",
      headers: { "X-TWP": "1", "Content-Type": "application/json" },
      body: "{}",
    });
    const headers = {
      Cookie: session.headers.get("set-cookie").split(";")[0],
      "X-TWP": "1",
      "Content-Type": "application/json",
    };
    const input = {
      kind: "api",
      name: "API connection",
      protocol: "chat",
      baseUrl: "http://127.0.0.1:" + upstream.address().port,
      credentialSource: "local",
      apiKey: key,
    };
    const connect = () =>
      fetch(origin + "/api/providers", {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      });
    const response = await connect(),
      text = await response.text();
    assert.equal(response.status, 201);
    assert.ok(!text.includes(key));
    const { provider } = JSON.parse(text);
    assert.equal(provider.credentialSource, "local");
    assert.equal(receivedKey, "Bearer " + key);
    assert.ok(!JSON.stringify(store.setting("api-providers")).includes(key));
    const directory = path.join(root, "runtime", "credentials");
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(path.join(directory, files[0]))).mode & 0o777,
      0o600,
    );
    assert.equal(await readFile(path.join(directory, files[0]), "utf8"), key);
    const restarted = new AgentRegistry(store, path.join(root, "runtime"));
    const c = store.createConversation();
    const member = store.addMember(c.id, {
      providerId: provider.id,
      model: "fixture-model",
      name: "Peer",
      parameters: {},
    });
    const driver = await restarted.driver(member, c);
    assert.equal(
      (
        await driver.run(
          "公开材料",
          () => {},
          () => {},
        )
      ).text,
      "公开回答",
    );
    const bootstrap = await (
      await fetch(origin + "/api/bootstrap", { headers })
    ).text();
    assert.ok(!bootstrap.includes(key));
    fail = true;
    const failure = await connect();
    assert.equal(failure.status, 400);
    assert.ok(!(await failure.text()).includes(key));
    fail = false;
    malformed = true;
    const invalid = await connect();
    assert.equal(invalid.status, 400);
    assert.ok(!(await invalid.text()).includes(key));
    assert.equal((await readdir(directory)).length, 1);
    await assert.rejects(
      apiKey({ id: "../escape", credentialSource: "local" }, directory),
      /不可用/,
    );
    restarted.close();
  } finally {
    await app.close();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
