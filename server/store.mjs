import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { safeError } from "./native-adapters.mjs";

const parse = (row) => (row ? JSON.parse(row.data) : null);
export class Store {
  constructor(filename) {
    if (filename !== ":memory:")
      mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.serviceId = randomUUID();
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at TEXT NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),data TEXT NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),created_at TEXT NOT NULL,data TEXT NOT NULL);" +
        "CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created_at);" +
        "CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),member_id TEXT,created_at TEXT NOT NULL,data TEXT NOT NULL);" +
        "CREATE INDEX IF NOT EXISTS events_conversation ON events(conversation_id,created_at);" +
        "CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY,data TEXT NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),member_id TEXT,created_at TEXT NOT NULL,data TEXT NOT NULL);" +
        "CREATE INDEX IF NOT EXISTS requests_conversation ON requests(conversation_id,created_at);" +
        "CREATE TABLE IF NOT EXISTS extension_runs(id TEXT PRIMARY KEY,conversation_id TEXT,created_at TEXT NOT NULL,data TEXT NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT,category TEXT NOT NULL,level TEXT NOT NULL,conversation_id TEXT,data TEXT NOT NULL);" +
        "CREATE INDEX IF NOT EXISTS logs_conversation ON logs(conversation_id,id);",
    );
    // Interrupted work is visible after restart; it is never a successful result.
    const previousService = parse(
      this.db
        .prepare(
          "SELECT data FROM logs WHERE category='service' AND json_extract(data,'$.action')='server.started' ORDER BY id DESC LIMIT 1",
        )
        .get(),
    );
    if (
      previousService &&
      !this.db
        .prepare(
          "SELECT id FROM logs WHERE category='service' AND json_extract(data,'$.action')='server.stopped' AND json_extract(data,'$.serviceId')=? LIMIT 1",
        )
        .get(previousService.serviceId)
    ) {
      this.log({
        category: "service",
        action: "server.prior-exit-unconfirmed",
        level: "warn",
        previousServiceId: previousService.serviceId,
        message: "上次服务退出未确认，历史日志保留",
      });
    }
    for (const row of this.db.prepare("SELECT data FROM members").all()) {
      const member = parse(row);
      if (
        !member.platformSession ||
        member.localSession !== member.platformSession
      ) {
        member.remoteSession ??= member.localSession ?? null;
        member.platformSession ??= randomUUID();
        member.localSession = member.platformSession;
        this.saveMember(member);
      }
    }
    for (const row of this.db
      .prepare("SELECT id,data FROM conversations")
      .all()) {
      const c = parse(row);
      if (c.status === "running") {
        c.status = "paused";
        c.pauseReason = "服务重启，讨论已暂停。";
        this.saveConversation(c);
        this.log({
          category: "service",
          action: "conversation.recovered",
          level: "warn",
          conversationId: c.id,
          message: "重启后暂停未完成讨论",
        });
      }
    }
    for (const row of this.db.prepare("SELECT id,data FROM messages").all()) {
      const m = parse(row);
      if (m.status === "streaming") {
        m.status = "interrupted";
        this.saveMessage(m);
      }
    }
    for (const row of this.db.prepare("SELECT data FROM requests").all()) {
      const request = parse(row);
      if (request.status === "pending")
        this.saveRequest({
          ...request,
          status: "interrupted",
          error: "服务重启，调用结果未完成确认。",
        });
    }
    for (const row of this.db
      .prepare("SELECT data FROM extension_runs")
      .all()) {
      const record = parse(row);
      if (record.status === "pending")
        this.saveExtensionRun({
          ...record,
          status: "interrupted",
          error: "服务重启，工具执行未完成确认。",
        });
    }
  }
  listConversations() {
    return this.db
      .prepare("SELECT data FROM conversations ORDER BY updated_at DESC")
      .all()
      .map(parse);
  }
  conversation(id) {
    return parse(
      this.db.prepare("SELECT data FROM conversations WHERE id=?").get(id),
    );
  }
  createConversation({ title = "新会话", projectPath = null } = {}) {
    const now = new Date().toISOString();
    const c = {
      id: randomUUID(),
      title,
      projectPath,
      status: "idle",
      contextVersion: 1,
      candidate: null,
      result: null,
      pauseReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.saveConversation(c);
    return c;
  }
  saveConversation(c) {
    this.db
      .prepare(
        "INSERT INTO conversations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
      )
      .run(c.id, JSON.stringify(c), c.updatedAt);
    return c;
  }
  patchConversation(id, patch) {
    const c = this.conversation(id);
    if (!c) throw new Error("会话不存在。");
    const previousStatus = c.status;
    Object.assign(c, patch, { updatedAt: new Date().toISOString() });
    if (c.status !== previousStatus)
      this.log({
        category: "discussion",
        action: "status.changed",
        conversationId: id,
        status: c.status,
        error: c.status === "paused" ? c.pauseReason : undefined,
        level: c.status === "paused" ? "warn" : "info",
        message: "讨论状态变更",
      });
    return this.saveConversation(c);
  }
  members(conversationId, { includeInactive = false } = {}) {
    return this.db
      .prepare("SELECT data FROM members WHERE conversation_id=?")
      .all(conversationId)
      .map(parse)
      .filter((m) => includeInactive || m.active);
  }
  member(id) {
    return parse(
      this.db.prepare("SELECT data FROM members WHERE id=?").get(id),
    );
  }
  addMember(conversationId, input) {
    if (!this.conversation(conversationId)) throw new Error("会话不存在。");
    const platformSession = randomUUID();
    const m = {
      id: randomUUID(),
      conversationId,
      active: true,
      localSession: platformSession,
      platformSession,
      createdAt: new Date().toISOString(),
      ...input,
    };
    this.saveMember(m);
    return m;
  }
  saveMember(m) {
    this.db
      .prepare(
        "INSERT INTO members VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(m.id, m.conversationId, JSON.stringify(m));
    return m;
  }
  patchMember(id, patch) {
    const m = this.member(id);
    if (!m) throw new Error("参与者不存在。");
    return this.saveMember({ ...m, ...patch });
  }
  messages(conversationId) {
    return this.db
      .prepare(
        "SELECT data FROM messages WHERE conversation_id=? ORDER BY created_at,rowid",
      )
      .all(conversationId)
      .map(parse);
  }
  saveMessage(m) {
    this.db
      .prepare(
        "INSERT INTO messages VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(m.id, m.conversationId, m.createdAt, JSON.stringify(m));
    return m;
  }
  addMessage(conversationId, input) {
    const m = {
      id: randomUUID(),
      conversationId,
      createdAt: new Date().toISOString(),
      status: "complete",
      ...input,
    };
    return this.saveMessage(m);
  }
  event(conversationId, memberId, type, summary, detail = {}) {
    const e = {
      id: randomUUID(),
      conversationId,
      memberId,
      type,
      summary,
      detail,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO events VALUES(?,?,?,?,?)")
      .run(e.id, conversationId, memberId, e.createdAt, JSON.stringify(e));
    return e;
  }
  events(conversationId, memberId = null) {
    const rows = memberId
      ? this.db
          .prepare(
            "SELECT data FROM events WHERE conversation_id=? AND member_id=? ORDER BY created_at,rowid",
          )
          .all(conversationId, memberId)
      : this.db
          .prepare(
            "SELECT data FROM events WHERE conversation_id=? ORDER BY created_at,rowid",
          )
          .all(conversationId);
    return rows.map(parse);
  }
  setting(id, fallback = null) {
    return (
      parse(this.db.prepare("SELECT data FROM settings WHERE id=?").get(id)) ??
      fallback
    );
  }
  saveRequest(record) {
    const previous = this.request(record.id);
    this.db
      .prepare(
        "INSERT INTO requests VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(
        record.id,
        record.conversationId,
        record.memberId ?? null,
        record.createdAt,
        JSON.stringify(record),
      );
    if (previous?.status !== record.status)
      this.log({
        category: "model",
        action: "request." + record.status,
        conversationId: record.conversationId,
        memberId: record.memberId,
        requestId: record.id,
        model: record.actualModel ?? record.model,
        phase: record.phase,
        round: record.round,
        status: record.status,
        durationMs: Math.max(0, Date.now() - Date.parse(record.createdAt)),
        inputHash: record.inputHash,
        errorCode: record.errorCode,
        error: record.error,
        level:
          record.status === "failed"
            ? "error"
            : ["interrupted", "invalid"].includes(record.status)
              ? "warn"
              : "info",
        message: "模型请求状态变更",
      });
    return record;
  }
  saveExtensionRun(record) {
    const previous = parse(
      this.db
        .prepare("SELECT data FROM extension_runs WHERE id=?")
        .get(record.id),
    );
    this.db
      .prepare(
        "INSERT INTO extension_runs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(
        record.id,
        record.conversationId ?? null,
        record.createdAt,
        JSON.stringify(record),
      );
    if (previous?.status !== record.status)
      this.log({
        category: "extension",
        action: (record.type === "hook" ? "hook." : "tool.") + record.status,
        conversationId: record.conversationId,
        memberId: record.memberId,
        requestId: record.requestId,
        executionId: record.id,
        parentExecutionId: record.parentExecutionId,
        extensionId: record.extensionId,
        contentHash: record.contentHash,
        resultHash: record.resultHash,
        version: record.version,
        event: record.event,
        status: record.status,
        durationMs: Math.max(0, Date.now() - Date.parse(record.createdAt)),
        error: record.error,
        level:
          record.status === "failed"
            ? "error"
            : ["blocked", "interrupted"].includes(record.status)
              ? "warn"
              : "info",
        message: record.type === "hook" ? "Hook 执行状态" : "工具执行状态",
      });
  }
  extensionRuns(conversationId = null) {
    return this.db
      .prepare(
        "SELECT data FROM extension_runs WHERE (? IS NULL OR conversation_id=?) ORDER BY created_at DESC,rowid DESC LIMIT 200",
      )
      .all(conversationId, conversationId)
      .map(parse);
  }
  log(record) {
    if (
      !["service", "http", "discussion", "model", "extension"].includes(
        record.category,
      ) ||
      !["info", "warn", "error"].includes(record.level ?? "info")
    )
      throw new Error("日志类型无效。");
    const data = {
      createdAt: new Date().toISOString(),
      serviceId: this.serviceId,
      level: "info",
    };
    // Only metadata enters operational logs; payloads remain in private request audits.
    for (const key of [
      "category",
      "previousServiceId",
      "action",
      "level",
      "message",
      "conversationId",
      "memberId",
      "requestId",
      "httpRequestId",
      "executionId",
      "parentExecutionId",
      "extensionId",
      "libraryId",
      "contentHash",
      "inputHash",
      "resultHash",
      "version",
      "event",
      "phase",
      "round",
      "status",
      "statusCode",
      "durationMs",
      "method",
      "route",
      "client",
      "errorCode",
      "error",
      "port",
      "model",
    ]) {
      const value = record[key];
      if (typeof value === "string") data[key] = safeError(value);
      else if (typeof value === "number" && Number.isFinite(value))
        data[key] = value;
    }
    const result = this.db
      .prepare(
        "INSERT INTO logs(category,level,conversation_id,data) VALUES(?,?,?,?)",
      )
      .run(
        data.category,
        data.level,
        data.conversationId ?? null,
        JSON.stringify(data),
      );
    return { id: Number(result.lastInsertRowid), ...data };
  }
  logs({
    before = null,
    limit = 50,
    category = null,
    level = null,
    conversationId = null,
    requestId = null,
  } = {}) {
    if (
      (before !== null && (!Number.isSafeInteger(before) || before < 1)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (category !== null &&
        !["service", "http", "discussion", "model", "extension"].includes(
          category,
        )) ||
      (level !== null && !["info", "warn", "error"].includes(level)) ||
      [conversationId, requestId].some(
        (v) => v !== null && (typeof v !== "string" || v.length > 100),
      )
    )
      throw new Error("日志筛选参数无效。");
    const rows = this.db
      .prepare(
        "SELECT id,data FROM logs WHERE (? IS NULL OR id<?) AND (? IS NULL OR category=?) AND (? IS NULL OR level=?) AND (? IS NULL OR conversation_id=?) AND (? IS NULL OR json_extract(data,'$.requestId')=?) ORDER BY id DESC LIMIT ?",
      )
      .all(
        before,
        before,
        category,
        category,
        level,
        level,
        conversationId,
        conversationId,
        requestId,
        requestId,
        limit + 1,
      );
    return {
      logs: rows.slice(0, limit).map((row) => ({ id: row.id, ...parse(row) })),
      nextBefore: rows.length > limit ? rows[limit - 1].id : null,
    };
  }
  request(id) {
    return parse(
      this.db.prepare("SELECT data FROM requests WHERE id=?").get(id),
    );
  }
  requests(conversationId, memberId = null) {
    return this.db
      .prepare(
        "SELECT data FROM requests WHERE conversation_id=? ORDER BY created_at,rowid",
      )
      .all(conversationId)
      .map(parse)
      .filter((r) => !memberId || r.memberId === memberId)
      .map(({ input, ...metadata }) => metadata);
  }
  saveSetting(id, data) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(id, JSON.stringify(data));
    return data;
  }
  workspace(id) {
    const c = this.conversation(id);
    return c
      ? {
          conversation: c,
          members: this.members(id),
          messages: this.messages(id),
          events: this.events(id),
        }
      : null;
  }
  close() {
    this.db.close();
  }
}
