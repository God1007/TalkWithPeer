import React, { useEffect, useState } from "react";

export default function RuntimeLogs({ api, conversationId }) {
  const [category, setCategory] = useState(""),
    [level, setLevel] = useState("");
  const [onlyCurrent, setOnlyCurrent] = useState(false),
    [requestId, setRequestId] = useState("");
  const [page, setPage] = useState(null),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState("");
  async function load(before = null, query = applied) {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams(query);
      if (before !== null) params.set("before", before);
      setPage(await api("/logs?" + params));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    load(null, "");
  }, [api]);
  return (
    <section className="runtime-logs">
      <p className="subtle">
        本机 SQLite
        持久化服务、配置和调用日志。日志只包含元数据；模型完整输入仍在会话请求审计中。新日志从本次更新起记录。
      </p>
      <form
        className="log-filters"
        onSubmit={(e) => {
          e.preventDefault();
          const q = new URLSearchParams();
          if (category) q.set("category", category);
          if (level) q.set("level", level);
          if (onlyCurrent && conversationId)
            q.set("conversationId", conversationId);
          if (requestId.trim()) q.set("requestId", requestId.trim());
          setApplied(q.toString());
          load(null, q.toString());
        }}
      >
        <label className="field">
          日志分类
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">全部</option>
            <option value="service">服务</option>
            <option value="http">HTTP</option>
            <option value="discussion">讨论</option>
            <option value="model">模型</option>
            <option value="extension">扩展</option>
          </select>
        </label>
        <label className="field">
          日志级别
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">全部</option>
            <option value="info">信息</option>
            <option value="warn">警告</option>
            <option value="error">错误</option>
          </select>
        </label>
        <label className="field">
          模型请求 ID
          <input
            value={requestId}
            maxLength={100}
            onChange={(e) => setRequestId(e.target.value)}
            placeholder="按 requestId 查看调用链"
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={onlyCurrent}
            disabled={!conversationId}
            onChange={(e) => setOnlyCurrent(e.target.checked)}
          />
          仅当前会话
        </label>
        <button className="button secondary" disabled={busy}>
          筛选并刷新
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      <div aria-live="polite">
        {page?.logs.length === 0 && (
          <p className="subtle">该筛选下暂无日志。</p>
        )}
        {page?.logs.map((log) => (
          <article className="runtime-section" key={log.id}>
            <div className="pane-heading">
              <strong>
                #{log.id} · {log.message}
              </strong>
              <span className="runtime-badge">{log.level}</span>
            </div>
            <p className="subtle">
              {new Date(log.createdAt).toLocaleString()} · {log.category} ·{" "}
              {log.action}
              {log.durationMs !== undefined
                ? " · " + log.durationMs + "ms"
                : ""}
            </p>
            <details>
              <summary>关联 ID 与详情</summary>
              <pre>{JSON.stringify(log, null, 2)}</pre>
            </details>
          </article>
        ))}
      </div>
      <button
        className="button secondary"
        disabled={busy || !page?.nextBefore}
        onClick={() => load(page.nextBefore)}
      >
        查看更早日志
      </button>
      <button className="text-button" disabled={busy} onClick={() => load()}>
        返回最新
      </button>
    </section>
  );
}
