import React, {useEffect,useRef,useState} from "react";
import {UploadSimple,FileText,CheckCircle,LockSimple} from "@phosphor-icons/react";
import {DOCUMENT_ACCEPT,documentMemo} from "../shared/document-import.mjs";
import {readDocument} from "./document-reader.mjs";

export default function DocumentImport({running,onSave,onClose}) {
  const [document,setDocument] = useState(null);
  const [text,setText] = useState("");
  const [error,setError] = useState(null);
  const [busy,setBusy] = useState(false);
  const control = useRef(null);
  const fileInput = useRef(null);
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
    <p className="document-intro">把简历或资料带入讨论。先核对识别结果，再分享给本会话的参与者。</p>
    <input ref={fileInput} type="file" accept={DOCUMENT_ACCEPT} onChange={choose} disabled={busy || running} hidden aria-label="文件" />
    {!document ? (
      <button className="document-picker" type="button" aria-label="选择文件" disabled={busy || running} onClick={() => fileInput.current?.click()}>
        <span className="document-picker-icon" aria-hidden="true"><UploadSimple size={26} /></span>
        <strong>{busy ? "正在识别文件…" : "点击选择简历或资料"}</strong>
        <span className="document-picker-formats">PDF · DOCX · TXT · Markdown</span>
        <span className="document-picker-limit">单个文件不超过 5MB</span>
      </button>
    ) : (
      <div className="document-selected">
        <span className="document-file-icon" aria-hidden="true"><FileText size={23} /></span>
        <div className="document-file-info">
          <strong title={document.name}>{document.name}</strong>
          <span><CheckCircle size={13} aria-hidden="true" /> 已读取 · {document.text.length.toLocaleString()} 字</span>
        </div>
        <button className="text-button" type="button" aria-label="更换文件" disabled={busy || running} onClick={() => fileInput.current?.click()}>更换</button>
      </div>
    )}
    <p className="document-local-note"><LockSimple size={14} aria-hidden="true" /><span>原文件在浏览器本地识别，仅在确认后保存预览文字。</span></p>
    {busy && <p role="status">正在处理文件…</p>}
    {document && <>
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
