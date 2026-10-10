import React, {useEffect,useRef,useState} from "react";
import {DOCUMENT_ACCEPT,documentMemo} from "../shared/document-import.mjs";
import {readDocument} from "./document-reader.mjs";

export default function DocumentImport({running,onSave,onClose}) {
  const [document,setDocument] = useState(null);
  const [text,setText] = useState("");
  const [error,setError] = useState(null);
  const [busy,setBusy] = useState(false);
  const control = useRef(null);
  useEffect(() => () => control.current?.abort(),[]);
  let memo, validation;
  if (document) {
    try { memo = documentMemo(document,text); }
    catch (e) { validation = e.message; }
  }
  const choose = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setDocument(null); setText(""); setError(null); setBusy(true);
    const controller = control.current = new AbortController();
    try {
      const result = await readDocument(file,controller.signal);
      if (!controller.signal.aborted) { setDocument(result); setText(result.text); }
    } catch (e) {
      if (!controller.signal.aborted) setError(e.message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return <form className="document-import" onSubmit={async (e) => {
    e.preventDefault();
    if (!memo || busy || running) return;
    setBusy(true); setError(null);
    try { await onSave(memo); onClose(); }
    catch (e) { setError(e.message); setBusy(false); }
  }}>
    <p className="subtle">PDF、DOCX、TXT 或 Markdown，最大 5MB。原文件在浏览器识别；确认后只把预览文字加入本会话的共享记录，供所有参与者读取。</p>
    <label className="field">选择文件
      <input type="file" accept={DOCUMENT_ACCEPT} onChange={choose} disabled={busy || running} />
    </label>
    {busy && <p role="status">正在处理文件…</p>}
    {document && <>
      <p className="document-name">{document.name}</p>
      {document.warnings.map((warning,i) => <p className="subtle" key={i}>{warning}</p>)}
      <label className="field">识别文字（可编辑）
        <textarea rows={12} value={text} onChange={e => {setText(e.target.value); setError(null);}} disabled={busy || running} />
      </label>
      <p className="subtle">{text.length.toLocaleString()} 字；含来源最多 8000 字。请核对遗漏、顺序和联系方式，删去不需要分享的内容。导入不会自动开始讨论。</p>
    </>}
    {(error || validation) && <p className="error-line" role="alert">{error || validation}</p>}
    <div className="form-buttons">
      <button className="button secondary" type="button" onClick={onClose}>取消</button>
      <button className="button primary" disabled={!memo || busy || running}>{busy ? "处理中…" : "确认导入共享记录"}</button>
    </div>
  </form>;
}
