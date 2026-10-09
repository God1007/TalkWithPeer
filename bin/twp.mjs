#!/usr/bin/env node
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { realpathSync } from "node:fs";
import { safeError } from "../server/native-adapters.mjs";

export const commands = {
  help: "命令列表",
  choose: "[连接编号或ID,...] 列出或添加 Agent；无参数时可输入编号选择",
  agents: "当前参与者",
  remove: "<参与者编号> 移除参与者",
  models: "<参与者编号> 模型和参数列表",
  model: "<编号> <模型ID> 切换模型",
  param: "<编号> <参数> <值> 调整模型参数",
  connect:
    "<deepseek|openai|anthropic> [--from-reasonix]；或 a2a <Card URL> [TOKEN_ENV]；或 api <chat|responses|messages> <名称> <基础URL> <KEY_ENV>",
  new: "[名称] 新会话",
  sessions: "会话列表",
  use: "<会话编号或ID> 切换会话",
  rename: "<名称> 重命名",
  project: "<路径|off> 项目目录",
  read: "<项目内相对文件路径> 读取文件加入共享 memo",
  memo: "[list|add <内容>|agent <编号> <内容>|remove <memo编号>] 管理记忆",
  context: "[full|budget <数量>|auto <on|off>] 查看或配置平台上下文",
  task: "[goal <内容>|constraints <内容;内容>|rebase] 查看目标与固定约束，或显式重设旧指令边界",
  capacity:
    "<编号> <windowTokens|outputReserve|extraReserve|safetyReserve> <数量|unknown> 设置成员容量",
  recall: "<消息ID,...> 回取本会话公共原文",
  inspect: "[请求ID] 查看请求清单或实际发送的输入",
  compact: "[参与者编号] 压缩早期轮次，保留原记录",
  show: "<messages|trace|result|all> 开启实时输出",
  hide: "<messages|trace|result|all> 关闭实时输出",
  focus: "<参与者编号|all> 筛选 Agent 实时回复",
  history: "[参与者编号] 公共消息记录",
  trace: "[参与者编号] 公开过程记录",
  result: "当前结果或暂停原因",
  rounds: "<1-8> 本次讨论判断轮数",
  resume: "继续讨论",
  stop: "暂停讨论",
  wait: "等待讨论",
  exit: "退出终端",
};
export const help = Object.entries(commands)
  .map(([key, description]) => "/" + key + "  " + description)
  .join("\n");
export class Terminal {
  constructor(request, write = console.log) {
    Object.assign(this, {
      request,
      write,
      id: null,
      rounds: 4,
      focus: null,
      pendingChoice: false,
      shown: new Set(["messages", "result"]),
      seenMessages: new Set(),
      seenEvents: new Set(),
      subscription: null,
      monitor: null,
      lastStatus: null,
    });
  }
  async workspace() {
    if (!this.id) throw new Error("请先 /new 或 /use。");
    return this.request("/conversations/" + this.id);
  }
  async member(value) {
    const members = (await this.workspace()).members;
    const m = members[Number(value) - 1] ?? members.find((m) => m.id === value);
    if (!m) throw new Error("参与者编号无效，使用 /agents 查看。");
    return m;
  }
  async providers() {
    let data = await this.request("/bootstrap");
    const deadline = Date.now() + 65000;
    while (data.discovering && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      data = await this.request("/bootstrap");
    }
    return data.providers;
  }
  async choose(value) {
    const providers = await this.providers();
    if (!value) {
      providers.forEach((p, i) =>
        this.write(
          i +
            1 +
            ". " +
            p.name +
            " [" +
            p.id +
            "] " +
            (p.available ? p.models.length + " 个模型" : (p.error ?? "未就绪")),
        ),
      );
      this.write("输入编号，用逗号分隔；也可 /choose codex,cursor。");
      this.pendingChoice = true;
      return;
    }
    const selected = value
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(
        (key) =>
          providers[Number(key) - 1] ??
          providers.find(
            (p) => p.id === key || p.name.toLowerCase() === key.toLowerCase(),
          ),
      );
    if (selected.some((p) => !p?.available))
      throw new Error("选择包含未就绪或不存在的 Agent。");
    for (const p of selected) {
      if ((await this.workspace()).members.some((m) => m.providerId === p.id))
        continue;
      const model = p.models.find((m) => m.default) ?? p.models[0];
      await this.request("/conversations/" + this.id + "/members", "POST", {
        providerId: p.id,
        name: p.name,
        model: model.id,
        parameters: {},
      });
      this.write("已加入 " + p.name + " · " + model.name);
    }
  }
  async use(id) {
    await this.close();
    this.id = id;
    this.seenMessages.clear();
    this.seenEvents.clear();
    const w = await this.workspace();
    w.messages.forEach((m) => this.seenMessages.add(m.id));
    w.events.forEach((e) => this.seenEvents.add(e.id));
    this.lastStatus = w.conversation.status;
    this.write("会话：" + w.conversation.title + " [" + id + "]");
    const control = (this.subscription = new AbortController());
    this.monitor = this.listen(id, control.signal).catch((error) => {
      if (!control.signal.aborted)
        this.write("实时连接中断：" + safeError(error));
    });
  }
  message(m) {
    const author =
      m.author === "user"
        ? "你"
        : m.author === "platform"
          ? "平台"
          : (m.authorName ?? m.author);
    return (
      "[" +
      author +
      (m.model ? " · " + m.model : "") +
      (m.round !== undefined ? " · 轮次 " + m.round : "") +
      "]\n" +
      (m.content || m.error || "已中断")
    );
  }
  async render(id) {
    if (id !== this.id) return;
    const w = await this.workspace();
    for (const m of w.messages) {
      if (m.status === "streaming" || this.seenMessages.has(m.id)) continue;
      this.seenMessages.add(m.id);
      const category = m.kind === "result" ? "result" : "messages";
      if (
        this.shown.has(category) &&
        (!this.focus ||
          m.author === this.focus ||
          ["user", "platform"].includes(m.author))
      )
        this.write("\n" + this.message(m));
    }
    for (const e of w.events) {
      if (this.seenEvents.has(e.id)) continue;
      this.seenEvents.add(e.id);
      if (
        this.shown.has("trace") &&
        (!this.focus || !e.memberId || e.memberId === this.focus)
      )
        this.write(
          "[过程 · " +
            (w.members.find((m) => m.id === e.memberId)?.name ?? "平台") +
            "] " +
            e.summary,
        );
    }
    if (w.conversation.status !== this.lastStatus) {
      this.lastStatus = w.conversation.status;
      if (w.conversation.status === "paused" && this.shown.has("result"))
        this.write("[平台 · 暂停] " + w.conversation.pauseReason);
    }
  }
  async listen(id, signal) {
    const response = await this.request(
      "/conversations/" + id + "/stream",
      "GET",
      undefined,
      { raw: true, signal },
    );
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith("data:")) await this.render(id);
      }
    }
    if (!signal.aborted) throw new Error("服务结束了实时连接。");
  }
  async wait() {
    while (
      this.id &&
      (await this.workspace()).conversation.status === "running"
    )
      await new Promise((resolve) => setTimeout(resolve, 300));
    if (this.id) await this.render(this.id);
  }
  async execute(line) {
    line = line.trim();
    if (!line) return;
    if (this.pendingChoice && !line.startsWith("/")) {
      this.pendingChoice = false;
      return this.choose(line);
    }
    this.pendingChoice = false;
    if (!line.startsWith("/")) {
      await this.workspace();
      return this.request("/conversations/" + this.id + "/discuss", "POST", {
        text: line,
        maxRounds: this.rounds,
      });
    }
    const [command, ...args] = line.slice(1).split(/\s+/),
      tail = args.join(" ");
    const endpoint = "/conversations/" + this.id;
    if (command === "help") return this.write(help);
    if (command === "exit") return "exit";
    if (command === "choose") {
      await this.workspace();
      return this.choose(tail);
    }
    if (command === "new") {
      const { conversation } = await this.request("/conversations", "POST", {
        title: tail || "新会话",
      });
      return this.use(conversation.id);
    }
    if (command === "sessions" || command === "use") {
      const { conversations } = await this.request("/bootstrap");
      if (command === "sessions")
        return conversations.forEach((c, i) =>
          this.write(i + 1 + ". " + c.title + " [" + c.id + "] " + c.status),
        );
      const c =
        conversations[Number(tail) - 1] ??
        conversations.find((c) => c.id === tail);
      if (!c) throw new Error("会话不存在。");
      return this.use(c.id);
    }
    if (command === "connect") {
      let input;
      if (args[0] === "a2a") input = { cardUrl: args[1], tokenEnv: args[2] };
      else if (args[0] === "api")
        input = {
          kind: "api",
          protocol: args[1],
          name: args[2],
          baseUrl: args[3],
          tokenEnv: args[4],
        };
      else {
        if (
          args.slice(1).some((arg) => arg !== "--from-reasonix") ||
          (args.includes("--from-reasonix") && args[0] !== "deepseek")
        )
          throw new Error("--from-reasonix 只可用于 deepseek。");
        input = {
          kind: "api",
          preset: args[0],
          credentialSource: args.includes("--from-reasonix")
            ? "reasonix"
            : "environment",
        };
      }
      const { provider } = await this.request("/providers", "POST", input);
      return this.write(
        "已连接 " +
          provider.name +
          " [" +
          provider.id +
          "]，使用 /choose 加入。",
      );
    }
    const w = await this.workspace();
    if (command === "task") {
      if (!args.length) {
        const { projection } = await this.request(endpoint + "/context");
        return this.write(JSON.stringify(projection.task, null, 2));
      }
      let patch;
      if (args[0] === "goal") patch = { goal: args.slice(1).join(" ") };
      else if (args[0] === "constraints")
        patch = {
          constraints: args
            .slice(1)
            .join(" ")
            .split(";")
            .map((t) => t.trim())
            .filter(Boolean),
        };
      else if (args[0] === "rebase") patch = { rebase: true };
      else throw new Error("使用 /task goal、constraints 或 rebase。");
      const saved = await this.request(endpoint + "/task", "PATCH", patch);
      return this.write(JSON.stringify(saved.task, null, 2));
    }
    if (command === "capacity") {
      const member = await this.member(args[0]);
      const number = args[2] === "unknown" ? null : Number(args[2]);
      if (number !== null && !Number.isInteger(number))
        throw new Error("容量应为整数或 unknown。");
      const saved = await this.request(
        endpoint + "/members/" + member.id,
        "PATCH",
        { capacity: { ...member.capacity, [args[1]]: number } },
      );
      return this.write(JSON.stringify(saved.member.capacity));
    }
    if (command === "recall") {
      const { messages } = await this.request(endpoint + "/evidence", "POST", {
        messageIds: tail.split(",").map((t) => t.trim()),
      });
      return messages.forEach((m) =>
        this.write("[" + m.author + " · " + m.id + "]\n" + m.content),
      );
    }
    if (command === "inspect") {
      const result = await this.request(
        tail ? endpoint + "/requests/" + tail : endpoint + "/context",
      );
      return this.write(
        JSON.stringify(
          tail
            ? result.request
            : result.requests.map(
                ({ id, phase, model, status, measured, capacity }) => ({
                  id,
                  phase,
                  model,
                  status,
                  measured,
                  capacity,
                }),
              ),
          null,
          2,
        ),
      );
    }
    if (command === "agents")
      return w.members.forEach((m, i) =>
        this.write(
          i +
            1 +
            ". " +
            m.name +
            " · " +
            m.model +
            " " +
            JSON.stringify(m.parameters),
        ),
      );
    if (["remove", "models", "model", "param"].includes(command)) {
      const m = await this.member(args[0]);
      if (command === "remove")
        return this.request(endpoint + "/members/" + m.id, "DELETE", {});
      const provider = (await this.providers()).find(
        (p) => p.id === m.providerId,
      );
      if (command === "models")
        return provider.models.forEach((model) =>
          this.write(
            model.id +
              " · " +
              model.name +
              "\n  " +
              JSON.stringify(model.parameters),
          ),
        );
      const patch =
        command === "model"
          ? { model: args[1], parameters: {}, capacity: {} }
          : {
              parameters: {
                ...m.parameters,
                [args[1]]: /^-?\d+$/.test(args[2] ?? "")
                  ? Number(args[2])
                  : args[2],
              },
            };
      const saved = await this.request(
        endpoint + "/members/" + m.id,
        "PATCH",
        patch,
      );
      return this.write(
        saved.member.name +
          " · " +
          saved.member.model +
          " " +
          JSON.stringify(saved.member.parameters),
      );
    }
    if (command === "rename")
      return this.request(endpoint, "PATCH", { title: tail });
    if (command === "project") {
      if (!tail) return this.write(w.conversation.projectPath ?? "未选择项目");
      return this.request(endpoint, "PATCH", {
        projectPath: tail === "off" ? null : path.resolve(tail),
      });
    }
    if (command === "read") {
      const { note } = await this.request(endpoint + "/read", "POST", {
        path: tail,
      });
      return this.write("已加入共享 memo：" + note.id);
    }
    if (command === "memo") {
      const { state } = await this.request(endpoint + "/context");
      if (!args.length || args[0] === "list")
        return state.notes.forEach((n, i) =>
          this.write(
            i +
              1 +
              ". [" +
              (w.members.find((m) => m.id === n.memberId)?.name ?? "共享") +
              "] " +
              n.text +
              "\n  " +
              n.id,
          ),
        );
      if (args[0] === "add" || args[0] === "agent") {
        const memberId =
          args[0] === "agent" ? (await this.member(args[1])).id : null;
        return this.request(endpoint + "/memo", "POST", {
          text: args.slice(memberId ? 2 : 1).join(" "),
          memberId,
        });
      }
      if (args[0] === "remove") {
        const note =
          state.notes[Number(args[1]) - 1] ??
          state.notes.find((n) => n.id === args[1]);
        if (!note) throw new Error("memo 不存在。");
        return this.request(endpoint + "/memo/" + note.id, "DELETE", {});
      }
      throw new Error("使用 /memo add、agent、remove 或 list。");
    }
    if (command === "context") {
      if (args[0] === "budget")
        return this.request(endpoint + "/context", "PATCH", {
          budget: Number(args[1]),
        });
      if (args[0] === "auto") {
        if (!["on", "off"].includes(args[1]))
          throw new Error("使用 on 或 off。");
        return this.request(endpoint + "/context", "PATCH", {
          auto: args[1] === "on",
        });
      }
      const context = await this.request(
        endpoint + "/context" + (this.focus ? "?memberId=" + this.focus : ""),
      );
      return this.write(
        JSON.stringify(
          args[0] === "full"
            ? context
            : {
                budget: context.state.budget,
                auto: context.state.auto,
                memoCount: context.state.notes.length,
                checkpointCount: context.state.checkpoints.length,
                currentMessages: context.projection.history.length,
                task: context.projection.task,
                capacities: context.capacities,
                lastRequest: context.requests.at(-1),
              },
          null,
          2,
        ),
      );
    }
    if (command === "compact") {
      const m = args[0] ? await this.member(args[0]) : w.members[0];
      if (!m) throw new Error("请先选择 Agent。");
      this.write("正在压缩早期轮次……");
      const { checkpoint } = await this.request(
        endpoint + "/compact",
        "POST",
        { memberId: m.id },
        { timeout: 180000 },
      );
      return this.write("[平台 · checkpoint]\n" + checkpoint.summary);
    }
    if (command === "show" || command === "hide") {
      if (!["messages", "trace", "result", "all"].includes(tail))
        throw new Error("类别应为 messages、trace、result 或 all。");
      for (const category of tail === "all"
        ? ["messages", "trace", "result"]
        : [tail])
        command === "show"
          ? this.shown.add(category)
          : this.shown.delete(category);
      return this.write("实时显示：" + [...this.shown].join(", "));
    }
    if (command === "focus") {
      this.focus = tail === "all" ? null : (await this.member(tail)).id;
      return this.write("已调整实时消息筛选。");
    }
    if (command === "history" || command === "trace") {
      const memberId = tail ? (await this.member(tail)).id : null;
      if (command === "history")
        return w.messages
          .filter(
            (m) =>
              m.status !== "streaming" && (!memberId || m.author === memberId),
          )
          .forEach((m) => this.write(this.message(m)));
      return w.events
        .filter((e) => !memberId || e.memberId === memberId)
        .forEach((e) =>
          this.write(
            "[过程 · " +
              (w.members.find((m) => m.id === e.memberId)?.name ?? "平台") +
              "] " +
              e.summary,
          ),
        );
    }
    if (command === "result")
      return this.write(
        w.conversation.result
          ? JSON.stringify(w.conversation.result, null, 2)
          : (w.conversation.pauseReason ?? "尚无终局结果。"),
      );
    if (command === "rounds") {
      const rounds = Number(tail);
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > 8)
        throw new Error("轮数应为 1–8。");
      this.rounds = rounds;
      return this.write("判断轮数：" + rounds);
    }
    if (command === "resume")
      return this.request(endpoint + "/continue", "POST", {
        maxRounds: this.rounds,
      });
    if (command === "stop") return this.request(endpoint + "/stop", "POST", {});
    if (command === "wait") return this.wait();
    throw new Error("未知命令：" + command + "，使用 /help。");
  }
  async close() {
    this.subscription?.abort();
    await this.monitor?.catch(() => {});
  }
}
export async function connectLocal(
  port = Number(process.env.TWP_PORT ?? 48273),
) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("端口无效。");
  const origin = "http://127.0.0.1:" + port;
  let app;
  try {
    const response = await fetch(origin + "/api/health", {
      signal: AbortSignal.timeout(1500),
    });
    const health = await response.json();
    if (health.app !== "TalkWithPeer" || health.version !== "0.3.0")
      throw new Error("端口上的服务需要更新或不是 TalkWithPeer。");
  } catch (error) {
    if (error.cause?.code !== "ECONNREFUSED") throw error;
    const { createApp } = await import("../server/index.mjs");
    app = await createApp();
    try {
      await new Promise((resolve, reject) => {
        app.server.once("error", reject);
        app.server.listen(port, "127.0.0.1", resolve);
      });
    } catch (error) {
      await app.close();
      throw error;
    }
  }
  const response = await fetch(origin + "/api/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-TWP": "1",
      Origin: origin,
    },
    body: "{}",
  });
  if (!response.ok) {
    await app?.close();
    throw new Error("本机服务认证失败。");
  }
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  const request = async (endpoint, method = "GET", body, options = {}) => {
    const response = await fetch(origin + "/api" + endpoint, {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-TWP": "1",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal ?? AbortSignal.timeout(options.timeout ?? 90000),
    });
    if (options.raw && response.ok) return response;
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "请求失败。");
    return result;
  };
  return { request, close: () => app?.close(), owned: Boolean(app) };
}
async function main() {
  if (process.argv.includes("--help")) {
    console.log(help);
    return;
  }
  const connection = await connectLocal(),
    terminal = new Terminal(connection.request);
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  const lines = readline[Symbol.asyncIterator]();
  let exiting = false;
  const interrupt = async () => {
    if (exiting) return;
    const w = await terminal.workspace().catch(() => null);
    if (w?.conversation.status === "running") {
      await terminal.execute("/stop");
      console.log("讨论已暂停。");
    } else {
      exiting = true;
      readline.close();
    }
  };
  readline.on("SIGINT", interrupt);
  process.on("SIGINT", interrupt);
  try {
    console.log("TalkWithPeer · /help 查看命令");
    const { conversations } = await connection.request("/bootstrap");
    if (conversations.length) await terminal.use(conversations[0].id);
    else await terminal.execute("/new");
    if (process.stdin.isTTY) {
      readline.setPrompt("twp> ");
      readline.prompt();
    }
    for await (const line of lines) {
      try {
        if ((await terminal.execute(line)) === "exit") {
          exiting = true;
          break;
        }
      } catch (error) {
        console.error(safeError(error));
      }
      if (process.stdin.isTTY) readline.prompt();
    }
    if (!exiting) await terminal.wait();
    else if (connection.owned) await terminal.execute("/stop");
  } finally {
    readline.close();
    process.off("SIGINT", interrupt);
    await terminal.close();
    await connection.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  main().catch((error) => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
