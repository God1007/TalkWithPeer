import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.mjs";
import { Terminal, connectLocal } from "../bin/twp.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { validateCapacity } from "../server/context.mjs";

test("CLI attaches shared server, selects agents and filters attributed messages without deleting history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "twp-cli-"));
  const providers = [
    {
      id: "fixture",
      name: "Peer",
      available: true,
      models: [{ id: "model", name: "Model", parameters: [] }],
    },
  ];
  const registry = {
    managedContext: true,
    list: () => providers,
    async refresh() {
      return providers;
    },
    validateMember(input) {
      return {
        name: input.name,
        providerId: "fixture",
        model: "model",
        parameters: {},
        capacity: validateCapacity(input.capacity),
      };
    },
    closeMember() {},
    close() {},
    async driver() {
      return {
        async run(prompt) {
          const candidateId = prompt.includes("请提出独立观点")
            ? undefined
            : [...prompt.matchAll(/"candidateId":"([^"]+)"/g)].at(-1)?.[1];
          return {
            model: "model",
            text: JSON.stringify(
              candidateId
                ? {
                    message: "判断",
                    candidateId,
                    stance: "accept",
                    acceptsSolution: true,
                    proposal: null,
                    disagreements: [],
                  }
                : { message: "公开观点", proposal: "共享方案" },
            ),
          };
        },
      };
    },
  };
  const app = await createApp({ root, registry });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  let connection, terminal;
  try {
    connection = await connectLocal(app.server.address().port);
    assert.equal(connection.owned, false);
    const output = [];
    terminal = new Terminal(connection.request, (line) => output.push(line));
    await terminal.execute("/new 终端会话");
    await terminal.execute("/choose");
    await terminal.execute("1");
    assert.equal((await terminal.workspace()).members.length, 1);
    await terminal.execute("/memo add 保留共享约束");
    await terminal.execute("/task goal 讨论方案");
    await terminal.execute("/task constraints 保留原文;不伪造共识");
    await terminal.execute("/capacity 1 windowTokens 16384");
    await terminal.execute("/context budget 16000");
    await terminal.execute("/hide messages");
    await terminal.execute("需要一个方案");
    await terminal.execute("/wait");
    const context = await connection.request(
      "/conversations/" + terminal.id + "/context",
    );
    assert.deepEqual(
      context.projection.task.constraints.map((c) => c.text),
      ["保留原文", "不伪造共识"],
    );
    assert.equal(context.capacities[0].inputLimit, 11776);
    assert.equal(context.capacities[0].windowSource, "user");
    assert.ok(context.requests.length >= 2);
    await terminal.execute("/inspect " + context.requests[0].id);
    assert.ok(
      output.some(
        (line) => line.includes('"inputHash"') && line.includes("保留原文"),
      ),
    );
    const originalUser = (await terminal.workspace()).messages.find(
      (m) => m.author === "user",
    );
    await terminal.execute("/recall " + originalUser.id);
    await assert.rejects(terminal.execute("/capacity 1 windowTokens nonsense"));
    await assert.rejects(terminal.execute("/task invalid"));
    const other = app.store.createConversation();
    assert.equal(
      (
        await fetch(
          "http://127.0.0.1:" +
            app.server.address().port +
            "/api/conversations/" +
            other.id +
            "/requests/" +
            context.requests[0].id,
          {
            headers: {
              Cookie: (
                await fetch(
                  "http://127.0.0.1:" +
                    app.server.address().port +
                    "/api/session",
                  {
                    method: "POST",
                    headers: {
                      "X-TWP": "1",
                      "Content-Type": "application/json",
                    },
                    body: "{}",
                  },
                )
              ).headers
                .get("set-cookie")
                .split(";")[0],
            },
          },
        )
      ).status,
      404,
    );
    assert.ok(
      output.some(
        (line) => line.includes("[平台]") && line.includes("共享方案"),
      ),
    );
    assert.ok(!output.some((line) => line.includes("[Peer · model")));
    await terminal.execute("/history 1");
    assert.ok(output.some((line) => line.includes("[Peer · model · 轮次 0]")));
    assert.equal(
      (await connection.request("/conversations/" + terminal.id + "/context"))
        .state.notes[0].text,
      "保留共享约束",
    );
    const project = path.join(root, "project");
    await mkdir(project);
    await writeFile(path.join(project, "notes.txt"), "真实项目内容");
    await writeFile(path.join(project, ".env"), "secret");
    await symlink(
      path.join(project, ".env"),
      path.join(project, "innocent.txt"),
    );
    await terminal.execute("/project " + project);
    await terminal.execute("/read notes.txt");
    const fileContext = await connection.request(
      "/conversations/" + terminal.id + "/context",
    );
    const material = fileContext.projection.memo.find((n) => n.material);
    assert.equal(material.material.hash.length, 64);
    assert.equal(material.material.path, "notes.txt");
    await terminal.execute("/project off");
    assert.ok(
      !(
        await connection.request("/conversations/" + terminal.id + "/context")
      ).projection.memo.some((n) => n.material),
    );
    await terminal.execute("/project " + project);
    await assert.rejects(terminal.execute("/read innocent.txt"), /凭证/);
    const privateMarker = "PRIVATE_STORE_FIXTURE_DO_NOT_SHARE";
    await mkdir(path.join(project, ".talkwithpeer"));
    await writeFile(
      path.join(project, ".talkwithpeer/private.txt"),
      privateMarker,
    );
    await symlink(
      path.join(project, ".talkwithpeer/private.txt"),
      path.join(project, "private-alias.txt"),
    );
    const beforePrivateRead = await connection.request(
      "/conversations/" + terminal.id + "/context",
    );
    await assert.rejects(
      terminal.execute("/read .talkwithpeer/private.txt"),
      /凭证/,
    );
    await assert.rejects(terminal.execute("/read private-alias.txt"), /凭证/);
    const afterPrivateRead = await connection.request(
      "/conversations/" + terminal.id + "/context",
    );
    assert.equal(
      afterPrivateRead.state.notes.length,
      beforePrivateRead.state.notes.length,
    );
    assert.ok(
      afterPrivateRead.state.notes.every(
        (n) => !n.text.includes(privateMarker),
      ),
    );
    await terminal.execute("/read notes.txt");
    assert.equal(
      (
        await connection.request("/conversations/" + terminal.id + "/context")
      ).projection.memo.findLast((n) => n.material).material.path,
      "notes.txt",
    );
    await assert.rejects(
      terminal.execute("/read ../workspace.sqlite"),
      /项目内/,
    );
    await assert.rejects(terminal.execute("/choose does-not-exist"));
    await terminal.close();
    await connection.close();
    assert.equal(
      (
        await fetch(
          "http://127.0.0.1:" + app.server.address().port + "/api/health",
        )
      ).status,
      200,
    );
  } finally {
    await terminal?.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("installed symlink starts CLI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "twp-entry-"));
  try {
    const entry = path.join(root, "twp");
    await symlink(
      fileURLToPath(new URL("../bin/twp.mjs", import.meta.url)),
      entry,
    );
    const { stdout } = await promisify(execFile)(process.execPath, [
      entry,
      "--help",
    ]);
    assert.ok(stdout.includes("/choose"));
    assert.ok(stdout.includes("/context"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
