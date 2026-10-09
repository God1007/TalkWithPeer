import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ApiAdapter, discoverApi, apiKey } from "../server/api-adapter.mjs";
import { resolveModel } from "../server/catalog.mjs";

test("three stateless API protocols preserve wire format, usage and reject partial output", async () => {
  const requests = [];
  let partial = false;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    requests.push({ url: req.url, headers: req.headers, body });
    let data;
    if (req.url === "/models") data = { data: [{ id: "model" }] };
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
      const output = await adapter.run(
        "共享上下文",
        () => {},
        () => {},
      );
      assert.equal(output.text, "公开回答");
      assert.ok(output.usage);
      const request = requests.at(-1);
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
