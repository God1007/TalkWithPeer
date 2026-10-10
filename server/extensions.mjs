import { readdir, readFile, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import { referenceFiles } from "./reference-files.mjs";
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const events = [
  "before_prompt",
  "before_tool",
  "after_tool",
  "after_reply",
  "after_compact",
];
const operations = {
  extension_read: {
    description: "分段读取已审查并授权的扩展资料，源码仅作文本，不执行",
    arguments: {
      extensionId: "本轮资料扩展ID",
      path: "审查清单中的精确文件路径",
      offset: "可选字符偏移，默认0",
      maxChars: "可选1–12000，默认8000",
    },
    capability: "extension-reference.read",
  },
  public_read: {
    description: "回取本会话已完成的公共消息",
    arguments: { messageIds: "1–3个公共消息ID" },
    capability: "public-history.read",
  },
  public_search: {
    description: "关键词搜索本会话公共消息，返回带来源的片段",
    arguments: { query: "1–200字关键词" },
    capability: "public-history.read",
  },
  project_read: {
    description: "只读所选项目的文本文件，不读取凭证文件",
    arguments: { path: "项目内相对路径" },
    capability: "project.read",
  },
};
export class ExtensionRegistry {
  constructor(store, context) {
    this.store = store;
    this.context = context;
  }
  state() {
    return this.store.setting("extensions", {
      libraries: [],
      reviews: {},
      enabled: {},
    });
  }
  save(state) {
    this.store.saveSetting("extensions", state);
  }
  async addLibrary(directory) {
    if (typeof directory !== "string" || !directory.trim())
      throw new Error("请输入本机扩展仓库路径。");
    const root = await realpath(directory);
    if (
      root === os.homedir() ||
      root === path.parse(root).root ||
      !(await lstat(root)).isDirectory()
    )
      throw new Error("请选择具体的扩展仓库目录。");
    const state = this.state();
    if (state.libraries.some((l) => l.root === root))
      return state.libraries.find((l) => l.root === root);
    if (state.libraries.length >= 16)
      throw new Error("一期最多登记16个本机扩展库。");
    const library = {
      id: randomUUID(),
      root,
      name: path.basename(root),
      addedAt: new Date().toISOString(),
    };
    state.libraries.push(library);
    this.save(state);
    this.store.log({
      category: "extension",
      action: "library.added",
      libraryId: library.id,
      message: "登记本机扩展库",
    });
    return library;
  }
  async package(library, folder) {
    const files = [];
    const walk = async (directory, depth = 0) => {
      if (depth > 3) throw new Error("扩展目录层级过深。");
      for (const name of (await readdir(directory)).sort()) {
        if (name === ".DS_Store") continue;
        if (name.startsWith(".")) throw new Error("扩展包内不允许隐藏文件。");
        const absolute = path.join(directory, name),
          info = await lstat(absolute);
        if (info.isSymbolicLink()) throw new Error("扩展包内不允许符号链接。");
        if (info.isDirectory()) await walk(absolute, depth + 1);
        else {
          if (
            !info.isFile() ||
            ![".json", ".md"].includes(path.extname(name)) ||
            info.size > 64000 ||
            files.length >= 20
          )
            throw new Error(
              "一期扩展仅支持最多20个、每个不超过64KB的 Markdown / JSON 文件。",
            );
          const bytes = await readFile(absolute);
          if (bytes.length > 64000 || bytes.includes(0))
            throw new Error("扩展文件超限或不是文本。");
          files.push({
            path: path.relative(folder, absolute),
            content: bytes.toString("utf8"),
          });
        }
      }
    };
    if ((await lstat(folder)).isSymbolicLink())
      throw new Error("扩展目录不能是符号链接。");
    await walk(folder);
    const manifest = JSON.parse(
      files.find((f) => f.path === "extension.json")?.content ?? "null",
    );
    if (
      !manifest ||
      manifest.schemaVersion !== 1 ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(manifest.id ?? "") ||
      !["skill", "tool", "hook", "reference"].includes(manifest.type) ||
      typeof manifest.name !== "string" ||
      !manifest.name.trim() ||
      manifest.name.length > 80 ||
      typeof manifest.description !== "string" ||
      manifest.description.length > 600 ||
      !/^\d+\.\d+\.\d+$/.test(manifest.version ?? "") ||
      typeof manifest.entry !== "string"
    )
      throw new Error("extension.json 格式无效。");
    const entry = files.find((f) => f.path === manifest.entry);
    if (!entry) throw new Error("扩展入口不在包内。");
    if (manifest.sources !== undefined) {
      if (manifest.type !== "reference")
        throw new Error("归档源只允许用于只读资料包。");
      files.push(...(await referenceFiles(library, manifest.sources)));
    }
    let definition = null,
      capability;
    if (manifest.type === "skill" || manifest.type === "reference") {
      if (path.extname(entry.path) !== ".md" || entry.content.length > 8000)
        throw new Error("工作流程或资料入口应为不超过8000字的 Markdown。");
      capability =
        manifest.type === "reference"
          ? "reference.read-only"
          : "context.workflow";
    } else {
      definition = JSON.parse(entry.content);
      if (
        !definition ||
        typeof definition !== "object" ||
        Array.isArray(definition)
      )
        throw new Error("扩展定义无效。");
      if (manifest.type === "tool") {
        if (
          !operations[definition.operation] ||
          Object.keys(definition).some((k) => k !== "operation")
        )
          throw new Error("一期工具只支持平台声明的只读操作。");
        capability = operations[definition.operation].capability;
      } else {
        if (
          !events.includes(definition.event) ||
          !["note", "deny", "audit"].includes(definition.operation) ||
          Object.keys(definition).some(
            (k) => !["event", "operation", "text", "when"].includes(k),
          ) ||
          (definition.operation === "note" &&
            (definition.event !== "before_prompt" ||
              typeof definition.text !== "string" ||
              !definition.text.trim() ||
              definition.text.length > 1000)) ||
          (definition.operation === "deny" &&
            definition.event !== "before_tool") ||
          (definition.when &&
            (typeof definition.when !== "object" ||
              typeof definition.when.toolId !== "string" ||
              Object.keys(definition.when).some((k) => k !== "toolId")))
        )
          throw new Error("Hook 事件或声明式操作无效。");
        capability =
          definition.operation === "note"
            ? "context.annotate"
            : definition.operation === "deny"
              ? "tool.intercept"
              : "execution.audit";
      }
    }
    return {
      id: library.id + ":" + manifest.id,
      libraryId: library.id,
      packagePath: path.relative(library.root, folder),
      manifest,
      definition,
      capability,
      files,
      contentHash: digest(files),
      entry: entry.content,
    };
  }
  async scan() {
    const state = this.state(),
      packages = [],
      errors = [];
    for (const library of state.libraries) {
      let commit = null;
      try {
        commit = (
          await exec("git", ["-C", library.root, "rev-parse", "HEAD"], {
            timeout: 3000,
          })
        ).stdout.trim();
      } catch {}
      for (const kind of ["skills", "tools", "hooks", "references"]) {
        const directory = path.join(library.root, kind);
        try {
          const info = await lstat(directory);
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error("扩展分类目录必须为普通目录。");
          for (const entry of await readdir(directory, {
            withFileTypes: true,
          })) {
            if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
            try {
              const item = await this.package(
                library,
                path.join(directory, entry.name),
              );
              if (item.manifest.type + "s" !== kind)
                throw new Error("扩展类型与分类目录不一致。");
              if (packages.some((p) => p.id === item.id))
                throw new Error("同一仓库中扩展ID重复。");
              const review = state.reviews[item.id];
              const reviewed = review?.contentHash === item.contentHash;
              packages.push({
                ...item,
                commit,
                review: review ?? null,
                reviewed,
                activeLock: Boolean(state.enabled[item.id]),
                enabled:
                  reviewed && state.enabled[item.id] === item.contentHash,
                status: reviewed
                  ? "reviewed"
                  : review
                    ? "changed"
                    : "unreviewed",
              });
            } catch (error) {
              errors.push({
                libraryId: library.id,
                path: kind + "/" + entry.name,
                error: error.message,
              });
            }
          }
        } catch (error) {
          if (error.code !== "ENOENT")
            errors.push({
              libraryId: library.id,
              path: kind,
              error: error.message,
            });
        }
      }
    }
    for (const [id, review] of Object.entries(state.reviews)) {
      if (packages.some((p) => p.id === id)) continue;
      const cached = this.store.setting(
        "extension-snapshot:" + review.contentHash,
      );
      if (cached)
        packages.push({
          ...cached,
          id,
          files: [],
          entry: "",
          definition: null,
          contentHash: null,
          commit: null,
          review,
          reviewed: false,
          enabled: false,
          activeLock: Boolean(state.enabled[id]),
          status: "unavailable",
        });
    }
    return {
      libraries: state.libraries,
      packages,
      errors,
      runs: this.store.extensionRuns(),
    };
  }
  async find(id) {
    const found = (await this.scan()).packages.find((e) => e.id === id);
    if (!found) throw new Error("扩展不存在或文件校验失败。");
    return found;
  }
  async review(id, { contentHash, note = "" }) {
    const item = await this.find(id);
    if (
      typeof contentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(contentHash) ||
      item.contentHash !== contentHash
    )
      throw new Error("文件已改变，请重新查看差异后审查。");
    if (typeof note !== "string" || note.length > 2000)
      throw new Error("审查备注无效。");
    const state = this.state();
    state.reviews[id] = {
      contentHash,
      version: item.manifest.version,
      commit: item.commit,
      note,
      reviewedAt: new Date().toISOString(),
    };
    this.store.saveSetting("extension-snapshot:" + contentHash, item);
    this.save(state);
    this.store.log({
      category: "extension",
      action: "review.approved",
      extensionId: id,
      contentHash,
      version: item.manifest.version,
      message: "批准扩展内容",
    });
    return state.reviews[id];
  }
  async enable(id, enabled, contentHash) {
    if (typeof enabled !== "boolean") throw new Error("启用状态无效。");
    const state = this.state();
    if (!enabled && (state.reviews[id] || state.enabled[id])) {
      state.enabled[id] = null;
      this.save(state);
      this.store.log({
        category: "extension",
        action: "version.disabled",
        extensionId: id,
        message: "停用扩展版本",
      });
      return { enabled: false };
    }
    const item = await this.find(id);
    if (enabled && (!item.reviewed || item.contentHash !== contentHash))
      throw new Error("启用前须审查当前内容并锁定哈希。");
    state.enabled[id] = enabled ? item.contentHash : null;
    this.save(state);
    this.store.log({
      category: "extension",
      action: enabled ? "version.enabled" : "version.disabled",
      extensionId: id,
      contentHash: item.contentHash,
      version: item.manifest.version,
      message: enabled ? "启用锁定扩展版本" : "停用扩展版本",
    });
    return { enabled };
  }
  async snapshot() {
    const { packages } = await this.scan(),
      enabled = packages.filter((p) => p.enabled);
    this.verifyLocks(
      packages,
      Object.entries(this.state().enabled)
        .filter(([, hash]) => hash)
        .map(([id, contentHash]) => ({ id, contentHash })),
    );
    return {
      locks: enabled.map((p) => ({
        id: p.id,
        contentHash: p.contentHash,
        version: p.manifest.version,
      })),
      skills: enabled
        .filter((p) => p.manifest.type === "skill")
        .map((p) => ({
          id: p.id,
          name: p.manifest.name,
          version: p.manifest.version,
          contentHash: p.contentHash,
          content: p.entry,
        })),
      tools: enabled
        .filter((p) => p.manifest.type === "tool")
        .map((p) => ({
          id: p.id,
          name: p.manifest.name,
          contentHash: p.contentHash,
          ...operations[p.definition.operation],
        })),
      annotations: enabled
        .filter(
          (p) =>
            p.manifest.type === "hook" && p.definition.operation === "note",
        )
        .map((p) => ({
          id: p.id,
          contentHash: p.contentHash,
          text: p.definition.text,
          authoritative: false,
        })),
      references: enabled
        .filter((p) => p.manifest.type === "reference")
        .map((p) => ({
          id: p.id,
          name: p.manifest.name,
          description: p.manifest.description,
          contentHash: p.contentHash,
          readOnly: true,
          files: p.files.map((f) => ({
            path: f.path,
            size: f.size,
            encoding: f.encoding,
            redacted: f.redacted,
          })),
        })),
    };
  }
  verifyLocks(packages, locks) {
    if (
      locks?.some(
        (lock) =>
          !packages.some(
            (p) =>
              p.id === lock.id &&
              p.enabled &&
              p.contentHash === lock.contentHash,
          ),
      )
    )
      throw new Error("已启用扩展已改变或不可用，请暂停并重新审查。");
  }
  async hooks(event, scope, signal, locks = null, toolId = null) {
    const { packages } = await this.scan();
    this.verifyLocks(packages, locks);
    for (const hook of packages.filter(
      (p) =>
        p.enabled && p.manifest.type === "hook" && p.definition.event === event,
    )) {
      if (signal?.aborted) throw signal.reason ?? new Error("执行已取消。");
      if (
        locks &&
        !locks.some(
          (l) => l.id === hook.id && l.contentHash === hook.contentHash,
        )
      )
        continue;
      if (
        hook.definition.when &&
        hook.definition.when.toolId !== toolId &&
        hook.definition.when.toolId !== toolId?.split(":").at(-1)
      )
        continue;
      const denied = hook.definition.operation === "deny";
      this.store.saveExtensionRun({
        id: randomUUID(),
        ...scope,
        extensionId: hook.id,
        type: "hook",
        event,
        contentHash: hook.contentHash,
        version: hook.manifest.version,
        status: denied ? "blocked" : "complete",
        createdAt: new Date().toISOString(),
      });
      if (denied) throw new Error(hook.manifest.name + " 拦截了工具调用。");
    }
  }
  async call(id, args, scope, signal, locks = null) {
    locks ??= (await this.snapshot()).locks;
    const item = await this.find(id);
    const record = {
      id: randomUUID(),
      ...scope,
      extensionId: id,
      type: "tool",
      contentHash: item.contentHash,
      version: item.manifest.version,
      createdAt: new Date().toISOString(),
      status: "pending",
      arguments: args,
    };
    this.store.saveExtensionRun(record);
    try {
      if (
        !item.enabled ||
        item.manifest.type !== "tool" ||
        (locks &&
          !locks.some((l) => l.id === id && l.contentHash === item.contentHash))
      )
        throw new Error("工具未启用、版本改变或不在本轮锁定清单内。");
      if (signal?.aborted) throw signal.reason ?? new Error("执行已取消。");
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("工具参数须为JSON对象。");
      const hookScope = { ...scope, parentExecutionId: record.id };
      await this.hooks("before_tool", hookScope, signal, locks, id);
      const c = this.store.conversation(scope.conversationId);
      if (!c) throw new Error("会话不存在。");
      let result;
      if (item.definition.operation === "extension_read") {
        if (
          Object.keys(args).some(
            (k) => !["extensionId", "path", "offset", "maxChars"].includes(k),
          ) ||
          typeof args.extensionId !== "string" ||
          typeof args.path !== "string"
        )
          throw new Error("资料参数无效。");
        const target = await this.find(args.extensionId);
        if (
          !target.enabled ||
          target.manifest.type !== "reference" ||
          !locks.some(
            (l) => l.id === target.id && l.contentHash === target.contentHash,
          )
        )
          throw new Error("资料未授权或不在本轮锁定清单内。");
        const file = target.files.find((f) => f.path === args.path);
        if (!file || ["binary", "symlink"].includes(file.encoding))
          throw new Error("资料不存在或不是可读文本。");
        const offset = args.offset ?? 0,
          maxChars = args.maxChars ?? 8000;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > file.content.length ||
          !Number.isInteger(maxChars) ||
          maxChars < 1 ||
          maxChars > 12000
        )
          throw new Error("资料读取范围无效。");
        const end = Math.min(file.content.length, offset + maxChars);
        result = {
          extensionId: target.id,
          path: file.path,
          contentHash: target.contentHash,
          fileHash: file.sha256,
          content: file.content.slice(offset, end),
          offset,
          nextOffset: end < file.content.length ? end : null,
          partial: offset > 0 || end < file.content.length,
          redacted: Boolean(file.redacted),
          readOnly: true,
        };
      } else if (item.definition.operation === "public_read") {
        if (Object.keys(args).some((k) => k !== "messageIds"))
          throw new Error("工具参数无效。");
        result = this.context.readEvidence(c.id, args.messageIds);
      } else if (item.definition.operation === "public_search") {
        if (
          Object.keys(args).some((k) => k !== "query") ||
          typeof args.query !== "string" ||
          !args.query.trim() ||
          args.query.length > 200
        )
          throw new Error("请输入1–200字的搜索关键词。");
        result = this.store
          .messages(c.id)
          .filter(
            (m) => m.status === "complete" && m.content.includes(args.query),
          )
          .slice(-5)
          .map((m) => ({
            sourceId: m.id,
            authorId: m.author,
            excerpt: m.content.slice(
              Math.max(0, m.content.indexOf(args.query) - 120),
              m.content.indexOf(args.query) + 500,
            ),
            partial: true,
          }));
      } else {
        if (
          Object.keys(args).some((k) => k !== "path") ||
          !c.projectPath ||
          typeof args.path !== "string" ||
          !args.path ||
          path.isAbsolute(args.path)
        )
          throw new Error("请选择项目并提供项目内相对文件路径。");
        const projectRoot = await realpath(c.projectPath);
        const filename = await realpath(path.resolve(projectRoot, args.path));
        if (
          !filename.startsWith(projectRoot + path.sep) ||
          /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.ssh|\.codex|\.reasonix|\.talkwithpeer|credentials[^/]*|[^/]*\.(?:pem|key|p12))(?=\/|$)/i.test(
            filename,
          )
        )
          throw new Error("工具不读取项目外文件、凭证或平台私有数据。");
        if ((await lstat(filename)).size > 20000)
          throw new Error("工具仅支持不超过20KB的文本文件。");
        const bytes = await readFile(filename, { signal });
        if (bytes.length > 20000 || bytes.includes(0))
          throw new Error("工具文件超限或不是文本。");
        result = {
          projectPath: projectRoot,
          path: path.relative(projectRoot, filename),
          content: bytes.toString("utf8"),
          contentHash: createHash("sha256").update(bytes).digest("hex"),
          capturedAt: new Date().toISOString(),
        };
      }
      if (signal?.aborted) throw signal.reason ?? new Error("执行已取消。");
      if (JSON.stringify(result).length > 100000)
        throw new Error("工具结果过大，请缩小读取范围。");
      await this.hooks("after_tool", hookScope, signal, locks, id);
      Object.assign(record, { status: "complete", resultHash: digest(result) });
      return {
        executionId: record.id,
        extensionId: id,
        contentHash: item.contentHash,
        result,
      };
    } catch (error) {
      Object.assign(record, {
        status: signal?.aborted ? "interrupted" : "failed",
        error: String(error.message).slice(0, 600),
      });
      throw error;
    } finally {
      this.store.saveExtensionRun(record);
    }
  }
}
