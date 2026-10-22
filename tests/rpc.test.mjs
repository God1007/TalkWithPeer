import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const rpcUrl = new URL("../server/rpc.mjs", import.meta.url).href;

for (const method of ["call", "notify"]) {
  test(`RPC ${method} handles a closed agent input without crashing the host`, async () => {
    const fixture = `
      import { closeSync } from "node:fs";
      closeSync(0);
      console.log(JSON.stringify({ method: "fixture/ready" }));
      setTimeout(() => {}, 1500);
    `;
    const host = `
      import assert from "node:assert/strict";
      import { once } from "node:events";
      import { RpcPeer } from ${JSON.stringify(rpcUrl)};
      const rpc = new RpcPeer(process.execPath,
        ["--input-type=module", "-e", ${JSON.stringify(fixture)}], process.cwd());
      let closed = 0;
      rpc.on("closed", () => closed++);
      try {
        await once(rpc, "message");
        const childClosed = once(rpc.child, "close");
        const peerClosed = once(rpc, "closed");
        ${method === "call" ? `const results = await Promise.allSettled([
          rpc.call("waiting", {}, 5000), rpc.call("ping", {}, 5000)]);` : `rpc.notify("ping");
        const results = [];`}
        assert.equal((await peerClosed)[0].message, "Agent 输入连接已断开。");
        for (const result of results) {
          assert.equal(result.status, "rejected");
          assert.equal(result.reason.message, "Agent 输入连接已断开。");
        }
        assert.equal(rpc.pending.size, 0);
        assert.equal(rpc.closed, true);
        assert.equal(closed, 1);
        assert.equal((await childClosed)[1], "SIGTERM");
        assert.equal(closed, 1);
        await assert.rejects(rpc.call("later", {}), /Agent 连接已结束/);
        console.log("HOST_SURVIVED");
      } finally {
        rpc.stop();
      }
    `;
    const { stdout } = await run(process.execPath,
      ["--input-type=module", "-e", host], { timeout: 10000 });
    assert.equal(stdout.trim(), "HOST_SURVIVED");
  });
}

test("RPC still delivers responses and notifications over an open input", async () => {
  const { RpcPeer } = await import(rpcUrl);
  const fixture = `
    const { createInterface } = await import("node:readline");
    for await (const line of createInterface({ input: process.stdin })) {
      const m = JSON.parse(line);
      console.log(JSON.stringify(m.id
        ? { id: m.id, result: m.params }
        : { method: "fixture/notified", params: m.params }));
    }
  `;
  const rpc = new RpcPeer(process.execPath,
    ["--input-type=module", "-e", fixture], process.cwd());
  try {
    assert.deepEqual(await rpc.call("echo", { value: 42 }), { value: 42 });
    const { once } = await import("node:events");
    const notification = once(rpc, "message");
    rpc.notify("notice", { value: 7 });
    assert.deepEqual((await notification)[0].params, { value: 7 });
    assert.equal(rpc.closed, false);
  } finally {
    rpc.stop();
  }
});
