import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

export function killProcess(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 1500);
  timer.unref();
}

export class RpcPeer extends EventEmitter {
  constructor(command, args, cwd) {
    super();
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child.stderr.on("data", () => {}); // Native diagnostics can contain account details.
    const lines = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    lines.on("line", (line) => {
      if (line.length > 4_000_000) {
        this.stop();
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const pending = this.pending.get(message.id);
      if (pending && (Object.hasOwn(message, "result") || message.error)) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error)
          pending.reject(
            new Error(message.error.message ?? "Agent 请求失败。"),
          );
        else pending.resolve(message.result);
      } else if (message.method) this.emit("message", message);
    });
    this.child.on("error", () =>
      this.finish(new Error(command + " 无法启动，请检查安装。")),
    );
    this.child.on("close", (code) =>
      this.finish(new Error(command + " 连接已结束（" + code + "）。")),
    );
  }
  finish(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }
  write(message) {
    if (this.closed) throw new Error("Agent 连接已结束。");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  call(method, params, timeout = 120000) {
    if (this.closed) return Promise.reject(new Error("Agent 连接已结束。"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Agent 请求超时。"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method, params = {}) {
    this.write({ jsonrpc: "2.0", method, params });
  }
  respond(id, result) {
    this.write({ jsonrpc: "2.0", id, result });
  }
  reject(id) {
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "此讨论空间不开放工具执行。" },
    });
  }
  stop() {
    killProcess(this.child);
    this.finish(new Error("Agent 连接已停止。"));
  }
}
