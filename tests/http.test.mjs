import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";

test("HTTP workspace validates access, saves configuration and runs the real engine", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "twp-http-"));
  const providers = [
    {
      id: "fixture",
      name: "Protocol fixture",
      kind: "fixture",
      available: true,
      models: [{ id: "model", name: "Model", parameters: [] }],
    },
  ];
  const registry = {
    async refresh() {
      return providers;
    },
    list() {
      return providers;
    },
    validateMember(input) {
      if (input.providerId !== "fixture" || input.model !== "model")
        throw new Error("Invalid model");
      return {
        providerId: input.providerId,
        model: input.model,
        name: input.name,
        parameters: {},
        petId: null,
      };
    },
    closeMember() {},
    close() {},
    async driver(member) {
      return {
        sessionId: "session-" + member.id,
        async run(prompt) {
          const candidateId = prompt.includes("请提出独立观点")
            ? undefined
            : [...prompt.matchAll(/"candidateId":"([^"]+)"/g)].at(-1)?.[1];
          return {
            text: JSON.stringify(
              candidateId
                ? {
                    message: "接受同一候选",
                    candidateId,
                    stance: "accept",
                    acceptsSolution: true,
                    proposal: null,
                    disagreements: [],
                  }
                : { message: "公开观点", proposal: "共同记录" },
            ),
            sessionId: "session-" + member.id,
            model: "model",
          };
        },
      };
    },
  };
  const app = await createApp({ root, registry });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + app.server.address().port;
  try {
    assert.equal((await fetch(origin + "/api/bootstrap")).status, 401);
    const page = await fetch(origin + "/");
    const cookie = page.headers.get("set-cookie").split(";")[0];
    const headers = {
      cookie,
      origin,
      "content-type": "application/json",
      "x-twp": "1",
    };
    const request = (endpoint, method = "GET", body) =>
      fetch(origin + "/api" + endpoint, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    assert.equal(
      (
        await fetch(origin + "/api/bootstrap", {
          headers: { cookie, origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    const badHost = await new Promise((resolve, reject) => {
      const req = http.get(
        origin + "/api/bootstrap",
        { headers: { cookie, Host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
    });
    assert.equal(badHost, 403);
    assert.equal(
      (
        await fetch(origin + "/api/conversations", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal((await request("/conversations", "POST", [])).status, 400);
    const { conversation } = await (
      await request("/conversations", "POST", { title: "持久会话" })
    ).json();
    const id = conversation.id;
    assert.equal(
      (await request("/conversations/" + id, "PATCH", { projectPath: "/" }))
        .status,
      400,
    );
    const project = path.join(root, "project");
    await mkdir(project);
    assert.equal(
      (await request("/conversations/" + id, "PATCH", { projectPath: project }))
        .status,
      200,
    );
    const { member } = await (
      await request("/conversations/" + id + "/members", "POST", {
        providerId: "fixture",
        model: "model",
        name: "Peer",
      })
    ).json();
    assert.equal(
      (
        await request("/conversations/" + id + "/discuss", "POST", {
          text: "协商共同记录",
          maxRounds: 2,
        })
      ).status,
      202,
    );
    await Promise.allSettled([...app.engine.tasks.values()]);
    const result = await (await request("/conversations/" + id)).json();
    assert.equal(result.conversation.status, "consensus");
    assert.equal(result.conversation.projectPath, await realpath(project));
    assert.equal(result.members[0].remoteSession, "session-" + member.id);
    assert.notEqual(
      result.members[0].localSession,
      result.members[0].remoteSession,
    );
    assert.equal(result.messages.filter((m) => m.kind === "result").length, 1);
    assert.equal(
      (
        await request(
          "/conversations/" + id + "/members/" + member.id,
          "DELETE",
          {},
        )
      ).status,
      200,
    );
    const after = await (await request("/conversations/" + id)).json();
    assert.equal(after.members.length, 0);
    assert.ok(after.messages.length > 0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
