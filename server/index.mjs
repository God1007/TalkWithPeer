import http from "node:http";
import { readFile, readdir, stat, realpath, mkdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store } from "./store.mjs";
import { AgentRegistry } from "./registry.mjs";
import { DiscussionEngine } from "./engine.mjs";
import { PetLibrary, listCodexPets } from "./pets.mjs";
import { safeError } from "./native-adapters.mjs";
import { ExtensionRegistry } from "./extensions.mjs";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const publicRoot = path.join(appRoot, "dist");
const dataRoot =
  process.env.TWP_DATA_DIR ?? path.join(appRoot, ".talkwithpeer");
export async function validProject(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 4000)
    throw new Error("请选择有效的本地项目目录。");
  const actual = await realpath(value);
  if (
    !(await stat(actual)).isDirectory() ||
    actual === path.parse(actual).root ||
    actual === os.homedir()
  )
    throw new Error("请选择具体的项目目录。");
  return actual;
}
export async function createApp({
  root = dataRoot,
  store: providedStore,
  registry: providedRegistry,
} = {}) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const store = providedStore ?? new Store(path.join(root, "workspace.sqlite"));
  const registry =
    providedRegistry ?? new AgentRegistry(store, path.join(root, "runtime"));
  const engine = new DiscussionEngine(store, registry);
  const extensions = new ExtensionRegistry(store, engine.context);
  engine.extensions = extensions;
  const pets = new PetLibrary(store, path.join(root, "pets"));
  const tokens = new Set();
  let loggingOpen = true;
  let discovering = true;
  const refresh = () =>
    registry.refresh().finally(() => {
      discovering = false;
    });
  refresh().catch(() => {
    discovering = false;
  });
  const json = (res, status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(data));
  };
  const editable = (id) => {
    if (engine.active.has(id))
      throw new Error("请先暂停讨论，再修改会话配置。");
    const c = store.conversation(id);
    if (!c) throw new Error("会话不存在。");
    return c;
  };
  const bump = (id) => {
    const c = store.conversation(id);
    store.patchConversation(id, {
      contextVersion: c.contextVersion + 1,
      candidate: null,
      result: null,
      status: "idle",
    });
    engine.update(id);
  };
  const server = http.createServer(async (req, res) => {
    const httpRequestId = randomUUID(),
      startedAt = Date.now();
    res.setHeader("X-Request-ID", httpRequestId);
    let recorded = false;
    const recordHttp = (aborted = false) => {
      if (recorded || !loggingOpen) return;
      recorded = true;
      const pathname = (req.url ?? "").split("?")[0];
      const statusCode = aborted ? 499 : res.statusCode;
      if (
        (req.method === "GET" && statusCode < 400) ||
        (pathname === "/api/session" && statusCode < 400) ||
        (aborted && pathname.endsWith("/stream"))
      )
        return;
      const known = new Set([
        "api",
        "bootstrap",
        "health",
        "session",
        "providers",
        "refresh",
        "extensions",
        "libraries",
        "review",
        "enable",
        "call",
        "pets",
        "codex",
        "import",
        "projects",
        "conversations",
        "members",
        "context",
        "task",
        "evidence",
        "requests",
        "memo",
        "compact",
        "discuss",
        "continue",
        "stop",
        "stream",
        "logs",
      ]);
      const parts = pathname.split("/");
      store.log({
        category: "http",
        action: aborted ? "request.aborted" : "request.finished",
        httpRequestId,
        method: req.method,
        route: parts.map((p) => (known.has(p) ? p : p ? ":id" : "")).join("/"),
        conversationId:
          parts[2] === "conversations" && /^[a-f0-9-]{36}$/.test(parts[3] ?? "")
            ? parts[3]
            : undefined,
        client: ["cli", "web"].includes(req.headers["x-twp-client"])
          ? req.headers["x-twp-client"]
          : "local",
        statusCode,
        durationMs: Date.now() - startedAt,
        level:
          statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info",
        message: statusCode >= 400 ? "HTTP 请求未成功" : "HTTP 写请求完成",
      });
    };
    res.once("finish", () => recordHttp());
    res.once("close", () => recordHttp(!res.writableFinished));
    const port = server.address().port;
    const hosts = ["127.0.0.1:" + port, "localhost:" + port];
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (!hosts.includes(req.headers.host)) {
      json(res, 403, { error: "仅允许本机访问。" });
      return;
    }
    const origin = "http://" + req.headers.host;
    let url;
    try {
      url = new URL(req.url, origin);
    } catch {
      json(res, 400, { error: "地址无效。" });
      return;
    }
    if (req.headers.origin && req.headers.origin !== origin) {
      json(res, 403, { error: "不接受跨站请求。" });
      return;
    }
    if (
      req.headers["sec-fetch-site"] === "cross-site" &&
      url.pathname.startsWith("/api/")
    ) {
      json(res, 403, { error: "不接受跨站请求。" });
      return;
    }
    const cookie = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("twp_session="))
      ?.slice(12);
    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, { app: "TalkWithPeer", version: "0.3.0" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session") {
      if (
        req.headers["x-twp"] !== "1" ||
        !req.headers["content-type"]?.startsWith("application/json")
      ) {
        json(res, 403, { error: "请求格式无效。" });
        return;
      }
      const token = randomUUID();
      tokens.add(token);
      res.setHeader(
        "Set-Cookie",
        "twp_session=" + token + "; HttpOnly; SameSite=Strict; Path=/",
      );
      req.resume();
      json(res, 200, { connected: true });
      return;
    }
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      if (url.pathname === "/") {
        if (!tokens.has(cookie)) {
          const token = randomUUID();
          tokens.add(token);
          res.setHeader(
            "Set-Cookie",
            "twp_session=" + token + "; HttpOnly; SameSite=Strict; Path=/",
          );
        }
      }
      let relative;
      try {
        relative =
          url.pathname === "/"
            ? "index.html"
            : decodeURIComponent(url.pathname.slice(1));
      } catch {
        json(res, 400, { error: "页面地址无效。" });
        return;
      }
      const filename = path.resolve(publicRoot, relative);
      if (!filename.startsWith(publicRoot + path.sep)) {
        json(res, 404, { error: "页面不存在。" });
        return;
      }
      try {
        const actual = await realpath(filename);
        if (!actual.startsWith(publicRoot + path.sep)) throw new Error();
        const content = await readFile(actual);
        const ext = path.extname(actual);
        const mime = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".webp": "image/webp",
          ".woff2": "font/woff2",
        };
        res.writeHead(200, {
          "Content-Type": mime[ext] ?? "application/octet-stream",
        });
        res.end(content);
      } catch {
        json(res, 404, { error: "页面不存在。请先构建前端。" });
      }
      return;
    }
    if (!tokens.has(cookie)) {
      json(res, 401, { error: "请从本机工作台打开会话。" });
      return;
    }
    if (!["GET", "POST", "PATCH", "DELETE"].includes(req.method)) {
      json(res, 405, { error: "请求方式不支持。" });
      return;
    }
    let body = {};
    if (req.method !== "GET") {
      if (
        req.headers["x-twp"] !== "1" ||
        !req.headers["content-type"]?.startsWith("application/json")
      ) {
        json(res, 403, { error: "请求格式无效。" });
        return;
      }
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 100000) {
            json(res, 413, { error: "请求内容过大。" });
            return;
          }
          chunks.push(chunk);
        }
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        json(res, 400, { error: "JSON 请求无效。" });
        return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        json(res, 400, { error: "请求内容无效。" });
        return;
      }
    }
    const pieces = url.pathname.split("/").filter(Boolean);
    try {
      if (url.pathname === "/api/bootstrap" && req.method === "GET") {
        json(res, 200, {
          conversations: store.listConversations(),
          providers: registry.list(),
          pets: pets.list(),
          discovering,
          home: os.homedir(),
          local: true,
        });
        return;
      }
      if (url.pathname === "/api/logs" && req.method === "GET") {
        const q = url.searchParams;
        json(
          res,
          200,
          store.logs({
            before: q.has("before") ? Number(q.get("before")) : null,
            limit: q.has("limit") ? Number(q.get("limit")) : 50,
            category: q.get("category"),
            level: q.get("level"),
            conversationId: q.get("conversationId"),
            requestId: q.get("requestId"),
          }),
        );
        return;
      }
      if (url.pathname === "/api/providers/refresh" && req.method === "POST") {
        discovering = true;
        json(res, 200, { providers: await refresh() });
        return;
      }
      if (url.pathname === "/api/extensions" && req.method === "GET") {
        json(res, 200, await extensions.scan());
        return;
      }
      if (
        pieces[1] === "extensions" &&
        req.method === "POST" &&
        pieces[2] !== "call"
      ) {
        if (engine.active.size)
          throw new Error("请先暂停正在进行的讨论，再修改扩展配置。");
        if (pieces[2] === "libraries") {
          json(res, 201, { library: await extensions.addLibrary(body.path) });
          return;
        }
        const id = decodeURIComponent(pieces[2] ?? "");
        if (pieces[3] === "review") {
          json(res, 200, { review: await extensions.review(id, body) });
          return;
        }
        if (pieces[3] === "enable") {
          json(
            res,
            200,
            await extensions.enable(id, body.enabled, body.contentHash),
          );
          return;
        }
      }
      if (pieces[1] === "extensions" && pieces[2] && req.method === "GET") {
        const item = await extensions.find(decodeURIComponent(pieces[2]));
        const previous = item.review
          ? store.setting("extension-snapshot:" + item.review.contentHash)
          : null;
        json(res, 200, {
          extension: item,
          previousFiles: previous?.files ?? [],
        });
        return;
      }
      if (url.pathname === "/api/extensions/call" && req.method === "POST") {
        const conversation = editable(body.conversationId);
        json(
          res,
          200,
          await extensions.call(
            body.extensionId,
            body.arguments,
            {
              conversationId: conversation.id,
              memberId: null,
              projectPath: conversation.projectPath,
            },
            AbortSignal.timeout(10000),
          ),
        );
        return;
      }
      if (url.pathname === "/api/providers" && req.method === "POST") {
        json(res, 201, {
          provider:
            body.kind === "api"
              ? await registry.addApi(body)
              : await registry.addA2A({
                  cardUrl: body.cardUrl,
                  tokenEnv: body.tokenEnv,
                }),
        });
        return;
      }
      if (url.pathname === "/api/pets" && req.method === "GET") {
        json(res, 200, { pets: pets.list(), codex: await listCodexPets() });
        return;
      }
      if (url.pathname === "/api/pets/import" && req.method === "POST") {
        const pet =
          body.source === "codex"
            ? await pets.importCodex(body.id)
            : body.source === "link"
              ? await pets.importLink(body.link)
              : null;
        if (!pet) throw new Error("请选择 pet 来源。");
        json(res, 201, { pet });
        return;
      }
      if (
        pieces[1] === "pets" &&
        pieces[3] === "sprite" &&
        req.method === "GET"
      ) {
        const { pet, bytes } = await pets.read(pieces[2]);
        res.writeHead(200, {
          "Content-Type": "image/" + pet.format,
          "Cache-Control": "private, max-age=86400",
        });
        res.end(bytes);
        return;
      }
      if (url.pathname === "/api/projects/browse" && req.method === "GET") {
        const requested =
          url.searchParams.get("path") ?? path.join(os.homedir(), "Documents");
        const current = await realpath(requested);
        if (!(await stat(current)).isDirectory())
          throw new Error("路径不是目录。");
        const entries = await readdir(current, { withFileTypes: true });
        const directories = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => ({ name: e.name, path: path.join(current, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        json(res, 200, {
          path: current,
          parent: path.dirname(current),
          directories: directories.slice(0, 250),
        });
        return;
      }
      if (url.pathname === "/api/conversations" && req.method === "POST") {
        const title =
          typeof body.title === "string"
            ? body.title.trim().slice(0, 100) || "新会话"
            : "新会话";
        json(res, 201, { conversation: store.createConversation({ title }) });
        return;
      }
      if (pieces[1] === "conversations" && pieces[2]) {
        const id = pieces[2];
        const c = store.conversation(id);
        if (!c) {
          json(res, 404, { error: "会话不存在。" });
          return;
        }
        if (pieces.length === 3 && req.method === "GET") {
          json(res, 200, store.workspace(id));
          return;
        }
        if (pieces.length === 3 && req.method === "PATCH") {
          editable(id);
          const patch = {};
          if (Object.hasOwn(body, "title")) {
            if (
              typeof body.title !== "string" ||
              !body.title.trim() ||
              body.title.length > 100
            )
              throw new Error("会话名称无效。");
            patch.title = body.title.trim();
          }
          if (Object.hasOwn(body, "projectPath")) {
            patch.projectPath =
              body.projectPath === null
                ? null
                : await validProject(body.projectPath);
            editable(id);
            for (const member of store.members(id)) {
              registry.closeMember(member.id);
              store.patchMember(member.id, {
                remoteSession: null,
                lastSyncedMessageId: null,
                syncedVersion: null,
              });
            }
          }
          store.patchConversation(id, patch);
          if (Object.hasOwn(patch, "projectPath")) bump(id);
          else engine.update(id);
          json(res, 200, store.workspace(id));
          return;
        }
        if (
          pieces[3] === "members" &&
          pieces.length === 4 &&
          req.method === "POST"
        ) {
          editable(id);
          if (store.members(id).length >= 8)
            throw new Error("每个会话最多支持 8 位参与者。");
          const input = registry.validateMember(body);
          if (input.petId && !pets.list().some((p) => p.id === input.petId))
            throw new Error("pet 不存在。");
          const member = store.addMember(id, input);
          bump(id);
          json(res, 201, { member });
          return;
        }
        if (pieces[3] === "members" && pieces[4]) {
          const member = store.member(pieces[4]);
          if (!member || member.conversationId !== id) {
            json(res, 404, { error: "参与者不存在。" });
            return;
          }
          if (req.method === "GET") {
            json(res, 200, {
              member,
              events: store.events(id, member.id),
              messages: store
                .messages(id)
                .filter((m) => m.author === member.id),
            });
            return;
          }
          editable(id);
          if (req.method === "PATCH") {
            const input = registry.validateMember({
              ...member,
              ...body,
              ...(body.model &&
              body.model !== member.model &&
              !Object.hasOwn(body, "capacity")
                ? { capacity: {} }
                : {}),
            });
            if (input.petId && !pets.list().some((p) => p.id === input.petId))
              throw new Error("pet 不存在。");
            registry.closeMember(member.id);
            store.patchMember(member.id, input);
            bump(id);
            json(res, 200, { member: store.member(member.id) });
            return;
          }
          if (req.method === "DELETE") {
            registry.closeMember(member.id);
            store.patchMember(member.id, { active: false });
            bump(id);
            json(res, 200, { removed: true });
            return;
          }
        }
        if (pieces[3] === "context" && req.method === "GET") {
          const snapshot = engine.snapshot(id, store.members(id));
          json(res, 200, {
            state: engine.context.state(id),
            capacities: store.members(id).map((member) => ({
              memberId: member.id,
              name: member.name,
              ...engine.context.capacity(
                id,
                member,
                registry.capacity?.(member),
              ),
            })),
            requests: store.requests(id),
            projection: engine.context.project(
              snapshot,
              url.searchParams.get("memberId"),
            ),
          });
          return;
        }
        if (pieces[3] === "context" && req.method === "PATCH") {
          editable(id);
          const patch = {};
          if (Object.hasOwn(body, "budget")) patch.budget = body.budget;
          if (Object.hasOwn(body, "auto")) patch.auto = body.auto;
          json(res, 200, { state: engine.context.configure(id, patch) });
          engine.update(id);
          return;
        }
        if (pieces[3] === "task" && req.method === "PATCH") {
          editable(id);
          const task = engine.context.configureTask(id, {
            goal: body.goal,
            constraints: body.constraints,
            rebase: body.rebase ?? false,
          });
          bump(id);
          json(res, 200, { task });
          return;
        }
        if (pieces[3] === "evidence" && req.method === "POST") {
          json(res, 200, {
            messages: engine.context.readEvidence(id, body.messageIds),
          });
          return;
        }
        if (pieces[3] === "requests" && pieces[4] && req.method === "GET") {
          const record = store.request(pieces[4]);
          if (!record || record.conversationId !== id) {
            json(res, 404, { error: "请求记录不存在。" });
            return;
          }
          json(res, 200, { request: record });
          return;
        }
        if (pieces[3] === "memo" && req.method === "POST") {
          editable(id);
          const note = engine.context.addNote(id, {
            text: body.text,
            memberId: body.memberId,
            sourceIds: body.sourceIds,
          });
          bump(id);
          json(res, 201, { note });
          return;
        }
        if (pieces[3] === "read" && req.method === "POST") {
          editable(id);
          if (
            !c.projectPath ||
            typeof body.path !== "string" ||
            !body.path ||
            path.isAbsolute(body.path)
          )
            throw new Error("请先选择项目，并提供项目内相对文件路径。");
          const actual = await realpath(path.resolve(c.projectPath, body.path));
          if (
            !actual.startsWith(c.projectPath + path.sep) ||
            /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.ssh|\.codex|\.reasonix|credentials[^/]*|[^/]*\.(?:pem|key|p12))(?=\/|$)/i.test(
              actual,
            )
          )
            throw new Error("该文件不在项目内，或属于凭证与运行配置。");
          const info = await stat(actual);
          if (!info.isFile() || info.size > 20000)
            throw new Error("仅支持不超过 20KB 的文本文件。");
          const bytes = await readFile(actual);
          editable(id);
          if (store.conversation(id).projectPath !== c.projectPath)
            throw new Error("项目已经切换，请重新读取文件。");
          if (bytes.length > 20000)
            throw new Error("读取时文件大小已超过 20KB。");
          if (bytes.includes(0)) throw new Error("文件不是文本。");
          const note = engine.context.addNote(id, {
            text: "项目文件：" + body.path + "\n" + bytes.toString("utf8"),
            material: {
              kind: "project-file",
              projectPath: c.projectPath,
              path: path.relative(c.projectPath, actual),
              hash: createHash("sha256").update(bytes).digest("hex"),
              capturedAt: new Date().toISOString(),
            },
          });
          bump(id);
          json(res, 201, { note });
          return;
        }
        if (pieces[3] === "memo" && pieces[4] && req.method === "DELETE") {
          editable(id);
          engine.context.removeNote(id, pieces[4]);
          bump(id);
          json(res, 200, { removed: true });
          return;
        }
        if (pieces[3] === "compact" && req.method === "POST") {
          editable(id);
          const member =
            store.members(id).find((m) => m.id === body.memberId) ??
            store.members(id)[0];
          if (!member || (body.memberId && member.id !== body.memberId))
            throw new Error("请选择有效的压缩 Agent。");
          json(res, 200, { checkpoint: await engine.compact(id, member) });
          return;
        }
        if (pieces[3] === "discuss" && req.method === "POST") {
          engine.start(id, body.text, { maxRounds: body.maxRounds ?? 4 });
          json(res, 202, { started: true });
          return;
        }
        if (pieces[3] === "continue" && req.method === "POST") {
          engine.start(id, null, {
            resume: true,
            maxRounds: body.maxRounds ?? 4,
          });
          json(res, 202, { started: true });
          return;
        }
        if (pieces[3] === "stop" && req.method === "POST") {
          engine.stop(id);
          json(res, 200, { requested: true });
          return;
        }
        if (pieces[3] === "stream" && req.method === "GET") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "X-Accel-Buffering": "no",
            Connection: "keep-alive",
          });
          const send = (event) => {
            if (!res.destroyed)
              res.write("data: " + JSON.stringify(event) + "\n\n");
          };
          send({ type: "workspace" });
          engine.on(id, send);
          const ping = setInterval(() => {
            if (!res.destroyed) res.write(": keepalive\n\n");
          }, 15000);
          res.on("close", () => {
            engine.off(id, send);
            clearInterval(ping);
          });
          return;
        }
      }
      json(res, 404, { error: "接口不存在。" });
    } catch (error) {
      json(res, 400, { error: safeError(error) });
    }
  });
  server.once("listening", () =>
    store.log({
      category: "service",
      action: "server.started",
      port: server.address().port,
      message: "本机服务已启动",
    }),
  );
  server.on("error", (error) =>
    store.log({
      category: "service",
      action: "server.error",
      level: "error",
      errorCode: error.code,
      message: "本机服务错误",
    }),
  );
  return {
    server,
    store,
    registry,
    engine,
    extensions,
    pets,
    async close() {
      await engine.close();
      registry.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      store.log({
        category: "service",
        action: "server.stopped",
        message: "本机服务已停止",
      });
      loggingOpen = false;
      store.close();
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const app = await createApp();
  const port = Number(process.env.TWP_PORT ?? 48273);
  app.server.on("error", (error) => {
    console.error(
      error.code === "EADDRINUSE"
        ? "端口已被占用，请关闭旧服务后再启动。"
        : "服务启动失败。",
    );
    process.exitCode = 1;
  });
  app.server.listen(port, "127.0.0.1", () =>
    console.log("TalkWithPeer: http://127.0.0.1:" + port + "/"),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => app.close().then(() => process.exit(0)));
}
