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
import { createHash } from "node:crypto";
import { Store } from "../server/store.mjs";
import { ContextManager } from "../server/context.mjs";
import { ExtensionRegistry } from "../server/extensions.mjs";
import { redactReference } from "../server/reference-files.mjs";
import { createApp } from "../server/index.mjs";
import { Terminal, connectLocal } from "../bin/twp.mjs";

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

test("sensitive JSON string arrays are redacted without changing ordinary arrays or placeholders", () => {
  const scalar = redactReference(
    JSON.stringify({
      apiKey: "SYNTHETIC_SCALAR_VALUE_ONLY",
      password: "",
      token: "${SYNTHETIC_ENV}",
      names: ["ordinary", ""],
    }),
  );
  assert.deepEqual(JSON.parse(scalar.content), {
    apiKey: "[REDACTED]",
    password: "",
    token: "${SYNTHETIC_ENV}",
    names: ["ordinary", ""],
  });
  assert.equal(scalar.redacted, true);
  const input = {
    apiKey: [
      "SYNTHETIC_ARRAY_VALUE_ONLY",
      ["SYNTHETIC_NESTED_ARRAY_ONLY", "", "${NESTED_ENV}"],
      "${SYNTHETIC_ENV}",
    ],
    nested: { Authorization: [["SYNTHETIC_HEADER_ARRAY_ONLY"], ""] },
    names: [
      "ordinary",
      ["nested ordinary", "", "${PUBLIC_ENV}"],
      { name: "kept" },
    ],
    count: 2,
  };
  const result = redactReference(JSON.stringify(input));
  assert.deepEqual(JSON.parse(result.content), {
    apiKey: [
      "[REDACTED]",
      ["[REDACTED]", "", "${NESTED_ENV}"],
      "${SYNTHETIC_ENV}",
    ],
    nested: { Authorization: [["[REDACTED]"], ""] },
    names: input.names,
    count: 2,
  });
  assert.equal(result.redacted, true);
});

test("sensitive JSON string arrays stay redacted across scan approval and reference reads while raw hashes detect rotation", async () => {
  const s = await fixture();
  try {
    const canary = "SYNTHETIC_ARRAY_VALUE_ONLY",
      filename = path.join(s.source, "arrays.json");
    const raw = JSON.stringify({
      apiKey: [canary, [canary + "_NESTED", "${SYNTHETIC_ENV}"]],
      names: ["ordinary"],
    });
    await writeFile(filename, raw);
    const scanned = await s.registry.scan();
    const reader = await s.approve("reader"),
      archive = await s.approve("archive");
    const file = archive.files.find((f) => f.path === "source/plugin/arrays.json");
    const cached = s.store.setting("extension-snapshot:" + archive.contentHash);
    const snapshot = await s.registry.snapshot(),
      c = s.store.createConversation();
    const { result } = await s.registry.call(
      reader.id,
      { extensionId: archive.id, path: file.path },
      { conversationId: c.id },
      undefined,
      snapshot.locks,
    );
    for (const [label, value] of [
      ["scan", scanned],
      ["approval cache", cached],
      ["reference read", result],
    ])
      assert.ok(
        !JSON.stringify(value).includes(canary),
        label + " must not expose sensitive array strings",
      );
    assert.equal(file.redacted, true);
    assert.equal(result.redacted, true);
    assert.equal(file.sha256, createHash("sha256").update(raw).digest("hex"));
    assert.equal(result.fileHash, file.sha256);
    assert.equal(
      await readFile(filename, "utf8"),
      raw,
      "redaction must not rewrite the source file",
    );
    const directory = snapshot.references
      .find((item) => item.id === archive.id)
      .files.find((item) => item.path === file.path);
    assert.equal(
      Object.hasOwn(directory, "content"),
      false,
      "the phase snapshot contains reference metadata, not document text",
    );
    await writeFile(
      filename,
      raw.replaceAll(canary, "SYNTHETIC_ROTATED_ARRAY_ONLY"),
    );
    const changed = await s.registry.find(archive.id),
      changedFile = changed.files.find((item) => item.path === file.path);
    assert.equal(
      changedFile.content,
      file.content,
      "rotated values have the same redacted representation",
    );
    assert.notEqual(changedFile.sha256, file.sha256);
    assert.notEqual(changed.contentHash, archive.contentHash);
    assert.equal(changed.enabled, false);
    await assert.rejects(s.registry.snapshot(), /改变|不可用/);
    await assert.rejects(
      s.registry.call(
        reader.id,
        { extensionId: archive.id, path: file.path },
        { conversationId: c.id },
        undefined,
        snapshot.locks,
      ),
      /改变|不可用|未授权/,
    );
  } finally {
    await s.close();
  }
});

test("legacy sensitive JSON string arrays are redacted in HTTP and terminal reviews without rewriting cached snapshots", async () => {
  const s = await fixture();
  let app, connection, terminal;
  try {
    const canary = "SYNTHETIC_LEGACY_ARRAY_ONLY",
      filePath = "source/plugin/arrays.json";
    await writeFile(
      path.join(s.source, "arrays.json"),
      JSON.stringify({ apiKey: ["${SYNTHETIC_ENV}"] }),
    );
    const archive = await s.approve("archive");
    const legacyContent = JSON.stringify({
      apiKey: [canary, [canary + "_NESTED"]],
    });
    const legacyFile = {
      path: filePath,
      content: legacyContent,
      encoding: "utf8",
      sha256: createHash("sha256").update(legacyContent).digest("hex"),
      size: Buffer.byteLength(legacyContent),
      redacted: false,
    };
    const retained = {
      path: "source/plugin/already-redacted.json",
      content: '{"region":"synthetic-old"}',
      encoding: "utf8",
      sha256: "a".repeat(64),
      size: 26,
      redacted: true,
    };
    const deleted = { ...legacyFile, path: "source/plugin/deleted-arrays.json" };
    const files = archive.files
      .map((file) => (file.path === filePath ? legacyFile : file))
      .concat(retained, deleted);
    const legacyHash = createHash("sha256")
        .update(JSON.stringify(files))
        .digest("hex"),
      cacheKey = "extension-snapshot:" + legacyHash;
    const legacy = { ...archive, files, contentHash: legacyHash },
      state = s.registry.state();
    state.reviews[archive.id] = {
      ...state.reviews[archive.id],
      contentHash: legacyHash,
    };
    state.enabled[archive.id] = legacyHash;
    s.store.saveSetting(cacheKey, legacy);
    s.store.saveSetting("extensions", state);
    const before = s.store.setting(cacheKey);
    app = await createApp({
      root: path.join(s.root, "app-data"),
      store: s.store,
      registry: {
        list: () => [],
        refresh: async () => [],
        close() {},
        closeMember() {},
      },
    });
    await new Promise((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(0, "127.0.0.1", resolve);
    });
    connection = await connectLocal(app.server.address().port);
    assert.equal(
      connection.owned,
      false,
      "the test attaches only to its already-listening synthetic service",
    );
    const reviews = [];
    for (const type of ["reference", "skill"]) {
      if (type === "skill") {
        await rm(path.join(s.root, "references/archive"), { recursive: true });
        await s.pack(
          "archive",
          "skill",
          "Synthetic workflow after reference migration.",
        );
      }
      const detail = await connection.request(
          "/extensions/" + encodeURIComponent(archive.id),
        ),
        output = [];
      terminal = new Terminal(connection.request, (line) => output.push(line));
      await terminal.execute("/ext review " + archive.id);
      reviews.push({ type, detail, output });
    }
    for (const { type, detail, output } of reviews) {
      assert.equal(detail.extension.manifest.type, type);
      assert.ok(
        !JSON.stringify(detail).includes(canary),
        type + " HTTP review must redact its historical reference snapshot",
      );
      assert.ok(
        !output.join("\n").includes(canary),
        type +
          " CLI current, previous and deleted file views must not expose legacy array values",
      );
      for (const original of [legacyFile, deleted]) {
        const previous = detail.previousFiles.find(
          (file) => file.path === original.path,
        );
        assert.deepEqual(JSON.parse(previous.content), {
          apiKey: ["[REDACTED]", ["[REDACTED]"]],
        });
        assert.deepEqual(
          {
            ...previous,
            content: original.content,
            redacted: original.redacted,
          },
          original,
          "redaction must preserve historical path, encoding, size and source hash",
        );
        assert.equal(previous.redacted, true);
      }
      assert.deepEqual(
        detail.previousFiles.find((file) => file.path === retained.path),
        retained,
        "an existing redacted marker is retained even when the content needs no new redaction",
      );
      assert.ok(output.some((line) => line.includes("[上次审查版本]")));
      assert.ok(output.some((line) => line.includes("[已删除] " + deleted.path)));
    }
    assert.deepEqual(
      s.store.setting(cacheKey),
      before,
      "review output must not rewrite the legacy database snapshot",
    );
  } finally {
    await terminal?.close();
    await connection?.close();
    if (app) await app.close();
    else s.store.close();
    await rm(s.root, { recursive: true, force: true });
  }
});

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
