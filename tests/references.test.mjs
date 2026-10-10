import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  access,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../server/store.mjs";
import { ContextManager } from "../server/context.mjs";
import { ExtensionRegistry } from "../server/extensions.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "twp-ref-"));
  const source = path.join(root, "source/plugin");
  await mkdir(source, { recursive: true });
  const pack = async (id, type, entry, extra = {}) => {
    const dir = path.join(root, type + "s", id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "extension.json"),
      JSON.stringify({
        schemaVersion: 1,
        id,
        type,
        name: id,
        version: "1.0.0",
        description: "fixture",
        entry: "entry.md",
        ...extra,
      }),
    );
    await writeFile(path.join(dir, "entry.md"), entry);
    return dir;
  };
  await pack("archive", "reference", "Only review source, never execute.", {
    sources: ["source/plugin"],
  });
  await pack("reader", "tool", JSON.stringify({ operation: "extension_read" }));
  await writeFile(
    path.join(source, "SKILL.md"),
    "完整文档与跨模块引用。".repeat(3000),
  );
  await writeFile(
    path.join(source, "runner.sh"),
    "touch '" + path.join(root, "SHOULD_NOT_EXIST") + "'\n",
  );
  await writeFile(
    path.join(source, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        internal: {
          command: "not-run",
          env: {
            SERVICE_ACCOUNT_SECRET_KEY: "source-secret-value",
            MCP_GATEWAY_REGION: "test",
          },
        },
      },
    }),
  );
  await writeFile(path.join(source, "compiled.pyc"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, "external.md"), "OUTSIDE_PRIVATE_CONTENT");
  await symlink(path.join(root, "external.md"), path.join(source, "linked.md"));
  const store = new Store(":memory:"),
    registry = new ExtensionRegistry(store, new ContextManager(store));
  await registry.addLibrary(root);
  const approve = async (id) => {
    const p = (await registry.scan()).packages.find(
      (p) => p.manifest.id === id,
    );
    await registry.review(p.id, { contentHash: p.contentHash });
    await registry.enable(p.id, true, p.contentHash);
    return p;
  };
  return {
    root,
    source,
    pack,
    store,
    registry,
    approve,
    close: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("private plugin archives are review-only, redact credentials, preserve hash locks and paginate text reads", async () => {
  const s = await fixture();
  try {
    const scanned = await s.registry.scan();
    assert.equal(scanned.errors.length, 0);
    const archive = scanned.packages.find((p) => p.manifest.id === "archive");
    assert.equal(archive.capability, "reference.read-only");
    assert.equal(archive.definition, null);
    assert.ok(!JSON.stringify(scanned).includes("source-secret-value"));
    assert.ok(!JSON.stringify(scanned).includes("OUTSIDE_PRIVATE_CONTENT"));
    assert.ok(
      (await readFile(path.join(s.source, ".mcp.json"), "utf8")).includes(
        "source-secret-value",
      ),
    );
    const reader = await s.approve("reader");
    const c = s.store.createConversation(),
      scope = { conversationId: c.id, requestId: "generator-request" };
    await assert.rejects(
      s.registry.call(
        reader.id,
        { extensionId: archive.id, path: "source/plugin/SKILL.md" },
        scope,
      ),
      /未授权/,
    );
    await s.approve("archive");
    const snapshot = await s.registry.snapshot();
    assert.equal(snapshot.skills.length, 0);
    assert.equal(snapshot.annotations.length, 0);
    assert.equal(snapshot.references.length, 1);
    const first = (
      await s.registry.call(
        reader.id,
        {
          extensionId: archive.id,
          path: "source/plugin/SKILL.md",
          maxChars: 12000,
        },
        scope,
      )
    ).result;
    assert.equal(first.partial, true);
    assert.equal(first.nextOffset, 12000);
    const second = (
      await s.registry.call(
        reader.id,
        {
          extensionId: archive.id,
          path: "source/plugin/SKILL.md",
          offset: first.nextOffset,
          maxChars: 12000,
        },
        scope,
      )
    ).result;
    assert.equal(
      first.content + second.content,
      (await readFile(path.join(s.source, "SKILL.md"), "utf8")).slice(0, 24000),
    );
    const mcp = (
      await s.registry.call(
        reader.id,
        { extensionId: archive.id, path: "source/plugin/.mcp.json" },
        scope,
      )
    ).result;
    assert.equal(mcp.redacted, true);
    assert.ok(!mcp.content.includes("source-secret-value"));
    await assert.rejects(
      s.registry.call(
        reader.id,
        { extensionId: archive.id, path: "../external.md" },
        scope,
      ),
      /不存在/,
    );
    for (const file of ["compiled.pyc", "linked.md"])
      await assert.rejects(
        s.registry.call(
          reader.id,
          { extensionId: archive.id, path: "source/plugin/" + file },
          scope,
        ),
        /可读文本/,
      );
    const script = (
      await s.registry.call(
        reader.id,
        { extensionId: archive.id, path: "source/plugin/runner.sh" },
        scope,
      )
    ).result;
    assert.ok(script.content.includes("touch"));
    await assert.rejects(access(path.join(s.root, "SHOULD_NOT_EXIST")));
    assert.ok(
      s.store
        .logs({ requestId: "generator-request" })
        .logs.some((r) => r.action === "tool.complete"),
    );
    await writeFile(
      path.join(s.source, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          internal: {
            command: "not-run",
            env: {
              SERVICE_ACCOUNT_SECRET_KEY: "rotated-secret-value",
              MCP_GATEWAY_REGION: "test",
            },
          },
        },
      }),
    );
    await assert.rejects(s.registry.snapshot(), /已改变/);
    const changed = await s.registry.find(archive.id);
    const originalFile = archive.files.find(
      (f) => f.path === "source/plugin/.mcp.json",
    );
    const changedFile = changed.files.find((f) => f.path === originalFile.path);
    assert.equal(changedFile.content, originalFile.content);
    assert.notEqual(changedFile.sha256, originalFile.sha256);
    assert.equal(changed.enabled, false);
    assert.ok(!JSON.stringify(changed).includes("rotated-secret-value"));
    await s.registry.enable(archive.id, false);
    await s.registry.snapshot();
  } finally {
    await s.close();
  }
});

test("archive source declarations cannot escape the library or become executable tools", async () => {
  const s = await fixture();
  try {
    await s.pack("escape", "reference", "unsafe", {
      sources: ["source/../../external.md"],
    });
    await s.pack(
      "disguised",
      "tool",
      JSON.stringify({ operation: "public_read" }),
      { sources: ["source/plugin"] },
    );
    const outside = await mkdtemp(path.join(os.tmpdir(), "twp-outside-"));
    try {
      await symlink(outside, path.join(s.root, "source/alias"));
      await s.pack("alias", "reference", "unsafe", {
        sources: ["source/alias/README.md"],
      });
      const scan = await s.registry.scan();
      assert.equal(scan.errors.length, 3);
      assert.equal(scan.packages.length, 2);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await s.close();
  }
});
