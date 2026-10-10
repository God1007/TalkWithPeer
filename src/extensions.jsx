import React, { useState, useEffect, useCallback } from "react";
export default function ExtensionManager({ running, api }) {
  const [data, setData] = useState(null),
    [directory, setDirectory] = useState(""),
    [libraryFilter, setLibraryFilter] = useState(""),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null),
    [note, setNote] = useState(""),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setData(await api("/extensions"));
  }, [api]);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, [refresh]);
  const perform = async (action) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      if (selected)
        setDetail(await api("/extensions/" + encodeURIComponent(selected)));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const visiblePackages = data?.packages.filter(
    (p) =>
      (!libraryFilter || p.libraryId === libraryFilter) &&
      (p.manifest.name + " " + p.manifest.id + " " + p.manifest.description)
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <div className="extension-manager">
      <p className="subtle">
        本机源文件经审查后锁定哈希，默认不启用。文件改变后须重新审查；一期只执行平台声明的只读工具和
        hook 操作。 资料包只供审查，原插件命令和 MCP 不会被激活。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          perform(() =>
            api("/extensions/libraries", "POST", { path: directory }),
          );
        }}
      >
        <label className="field">
          本机扩展仓库路径
          <input
            value={directory}
            required
            onChange={(e) => setDirectory(e.target.value)}
            placeholder="/path/to/TalkWithPeer-extensions"
          />
        </label>
        <button className="button secondary" disabled={running || busy}>
          登记扩展库
        </button>
        <button
          className="text-button"
          type="button"
          disabled={busy}
          onClick={() => perform(refresh)}
        >
          刷新文件与版本
        </button>
      </form>
      <div className="capacity-list">
        {data?.libraries.map((l) => (
          <article key={l.id}>
            <strong>{l.name}</strong>
            <small>{l.root}</small>
          </article>
        ))}
      </div>
      <div className="extension-grid">
        <label className="field">
          筛选扩展库
          <select
            value={libraryFilter}
            onChange={(e) => setLibraryFilter(e.target.value)}
          >
            <option value="">全部扩展库</option>
            {data?.libraries.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          搜索扩展
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="名称、ID 或说明"
          />
        </label>
      </div>
      <div className="extension-grid">
        {visiblePackages?.map((p) => (
          <article className="runtime-section" key={p.id}>
            <div className="pane-heading">
              <strong>{p.manifest.name}</strong>
              <span className="runtime-badge">{p.manifest.type}</span>
            </div>
            <p className="subtle">{p.manifest.description}</p>
            <p>
              v{p.manifest.version} ·{" "}
              {
                {
                  reviewed: "已审查",
                  changed: "源文件已变更",
                  unreviewed: "待审查",
                  unavailable: "源文件不可用",
                }[p.status]
              }{" "}
              ·{" "}
              {p.manifest.type === "reference"
                ? p.enabled
                  ? "已授权只读"
                  : "未授权"
                : p.enabled
                  ? "已启用"
                  : "未启用"}
            </p>
            <code className="request-hash">{p.contentHash}</code>
            <button
              className="button secondary"
              onClick={async () => {
                try {
                  setSelected(p.id);
                  setDetail(
                    await api("/extensions/" + encodeURIComponent(p.id)),
                  );
                  setNote("");
                } catch (e) {
                  setError(e.message);
                }
              }}
            >
              查看文件与差异
            </button>
            <button
              className="text-button"
              disabled={running || busy || (!p.activeLock && !p.reviewed)}
              onClick={() =>
                perform(() =>
                  api(
                    "/extensions/" + encodeURIComponent(p.id) + "/enable",
                    "POST",
                    { enabled: !p.activeLock, contentHash: p.contentHash },
                  ),
                )
              }
            >
              {p.activeLock
                ? "停用"
                : p.manifest.type === "reference"
                  ? "授权只读资料"
                  : "启用锁定版本"}
            </button>
          </article>
        ))}
      </div>
      {detail && (
        <section className="runtime-section extension-review">
          <div className="pane-heading">
            <h3>审查 {detail.extension.manifest.name}</h3>
            <button
              className="text-button"
              onClick={() => {
                setSelected(null);
                setDetail(null);
              }}
            >
              收起
            </button>
          </div>
          <p className="subtle">
            平台能力：{detail.extension.capability} · Git commit：
            {detail.extension.commit ?? "未提交"}
          </p>
          <code className="request-hash">{detail.extension.contentHash}</code>
          {detail.extension.files.map((file) => {
            const old = detail.previousFiles.find((f) => f.path === file.path);
            return (
              <details key={file.path} open={file.path === "extension.json"}>
                <summary>
                  {file.path} · {file.redacted && "凭证已脱敏 · "}
                  {["binary", "symlink"].includes(file.encoding) &&
                    "仅元数据 · "}
                  {old
                    ? old.content === file.content && old.sha256 === file.sha256
                      ? "未变更"
                      : "已变更"
                    : "新文件"}
                </summary>
                {file.sha256 && (
                  <code className="request-hash">
                    原始文件 SHA-256：{file.sha256}
                  </code>
                )}
                <pre>{file.content}</pre>
                {old &&
                  (old.content !== file.content ||
                    old.sha256 !== file.sha256) && (
                    <>
                      <h4>上次审查内容</h4>
                      {old.sha256 && (
                        <code className="request-hash">
                          原始文件 SHA-256：{old.sha256}
                        </code>
                      )}
                      <pre>{old.content}</pre>
                    </>
                  )}
              </details>
            );
          })}
          {detail.previousFiles
            .filter(
              (f) => !detail.extension.files.some((n) => n.path === f.path),
            )
            .map((f) => (
              <details key={f.path}>
                <summary>已删除：{f.path}</summary>
                <pre>{f.content}</pre>
              </details>
            ))}
          <label className="field">
            审查备注
            <input
              value={note}
              maxLength={2000}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <button
            className="button primary"
            disabled={
              running || busy || detail.extension.status === "unavailable"
            }
            onClick={() =>
              perform(() =>
                api(
                  "/extensions/" + encodeURIComponent(selected) + "/review",
                  "POST",
                  { contentHash: detail.extension.contentHash, note },
                ),
              )
            }
          >
            批准当前内容并锁定版本
          </button>
          <p className="subtle">
            批准不会自动启用；请先核对所有文件，再启用锁定版本。
          </p>
        </section>
      )}
      {!!data?.errors.length && (
        <div className="runtime-section">
          {data.errors.map((e, i) => (
            <p key={i}>
              {e.path}：{e.error}
            </p>
          ))}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
