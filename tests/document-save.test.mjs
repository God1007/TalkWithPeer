import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("a saved document stays successful when the following workspace refresh fails", async () => {
  const source = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
  const start = source.indexOf("onSave={async (memo) => {");
  const end = source.indexOf("\n            }} />", start);
  assert.ok(start >= 0 && end > start);
  // Exercise the actual callback passed to DocumentImport, including its API/refresh ordering.
  const callback = source.slice(start + "onSave={".length, end) + "}";
  let posts = 0, refreshes = 0, writeFails = false;
  const errors = [];
  const save = new Function("api", "load", "modal", "setError", "return (" + callback + ");")(
    async (endpoint, method, body) => {
      assert.equal(endpoint, "/conversations/fixture/memo");
      assert.equal(method, "POST");
      assert.equal(body.text, "synthetic document");
      if (writeFails) throw new Error("memo write failed");
      posts++;
    },
    async target => {
      assert.equal(target, "fixture");
      refreshes++;
      throw new Error("workspace refresh failed");
    },
    { conversationId: "fixture" },
    error => errors.push(error),
  );
  await assert.doesNotReject(save("synthetic document"), "an acknowledged save must close the import form, not invite another POST");
  assert.equal(posts, 1);
  assert.equal(refreshes, 1);
  assert.match(errors[0], /文件已导入.*workspace refresh failed/);
  writeFails = true;
  await assert.rejects(save("synthetic document"), /memo write failed/);
  assert.equal(posts, 1);
  assert.equal(refreshes, 1, "failed persistence must not refresh or claim success");
  assert.equal(errors.length, 1);
});
