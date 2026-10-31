import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createApp } from "../server/index.mjs";
import { connectLocal } from "../bin/twp.mjs";

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "twp-cache-origin-"));
  let app, connection;
  try {
    app = await createApp({
      root: path.join(root, "data"),
      registry: { list: () => [], refresh: async () => [], close() {}, closeMember() {} },
    });
    const folders = ["tools/original-folder", "tools/other-folder"];
    const libraries = [];
    for (const [index, folder] of folders.entries()) {
      const libraryRoot = path.join(root, "library-" + index);
      const directory = path.join(libraryRoot, folder);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "extension.json"), JSON.stringify({
        schemaVersion: 1, id: "reader", type: "tool", name: "Reader",
        version: "1.0.0", description: "Synthetic fixture", entry: "definition.json",
      }));
      await writeFile(path.join(directory, "definition.json"), JSON.stringify({ operation: "public_read" }));
      libraries.push(await app.extensions.addLibrary(libraryRoot));
    }
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    connection = await connectLocal(app.server.address().port);
    const catalog = await connection.request("/extensions");
    const items = libraries.map(library => catalog.packages.find(p => p.libraryId === library.id));
    assert.equal(items[0].contentHash, items[1].contentHash, "identical content can share a snapshot hash across libraries");
    await run({ app, request: connection.request, libraries, items, folders });
  } finally {
    await connection?.close();
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("unavailable extension caches retain their reviewed library and package path", async () => {
  await fixture(async ({ app, request, libraries, items, folders }) => {
    const [first, second] = items;
    await app.extensions.review(first.id, { contentHash: first.contentHash });
    await app.extensions.enable(first.id, true, first.contentHash);
    await app.extensions.review(second.id, { contentHash: second.contentHash });
    await rm(path.join(libraries[0].root, folders[0]), { recursive: true });
    const catalog = await request("/extensions");
    const unavailable = catalog.packages.find(p => p.id === first.id);
    assert.equal(unavailable.libraryId, libraries[0].id, "the unavailable package must stay in its original library filter");
    assert.equal(unavailable.packagePath, "tools/original-folder");
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.enabled, false);
    assert.equal(unavailable.activeLock, true);
    assert.equal(catalog.packages.find(p => p.id === second.id).libraryId, libraries[1].id);
    const detail = await request("/extensions/" + encodeURIComponent(first.id));
    assert.equal(detail.extension.libraryId, libraries[0].id);
    assert.equal(detail.extension.packagePath, "tools/original-folder");
    await assert.rejects(app.extensions.snapshot(), /已改变/);
    await app.extensions.enable(first.id, false);
    assert.equal((await app.extensions.snapshot()).locks.length, 0);
  });
});

test("legacy approvals do not borrow another package's cached path", async t => {
  for (const shared of [false, true]) {
    await t.test(shared ? "shared cache has unknown legacy path" : "matching cache retains legacy path", async () => {
      await fixture(async ({ app, request, libraries, items, folders }) => {
        const [first, second] = items;
        await app.extensions.review(first.id, { contentHash: first.contentHash });
        // Model an approval persisted before packagePath was recorded.
        const legacy = app.extensions.state();
        delete legacy.reviews[first.id].packagePath;
        app.extensions.save(legacy);
        if (shared) await app.extensions.review(second.id, { contentHash: second.contentHash });
        await rm(path.join(libraries[0].root, folders[0]), { recursive: true });
        const catalog = await request("/extensions");
        const unavailable = catalog.packages.find(p => p.id === first.id);
        assert.equal(unavailable.libraryId, libraries[0].id);
        assert.equal(unavailable.packagePath, shared ? null : "tools/original-folder");
        assert.equal(unavailable.review.contentHash, first.contentHash);
      });
    });
  }
});
