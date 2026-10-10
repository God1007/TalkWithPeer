import {getDocument,GlobalWorkerOptions} from "pdfjs-dist/legacy/build/pdf.mjs";
import {MAX_EXTRACTED_CHARS} from "../shared/document-import.mjs";

GlobalWorkerOptions.workerSrc = "/assets/pdf-worker.js";
export async function readPdf(buffer,signal) {
  const bytes = new Uint8Array(buffer);
  if (new TextDecoder().decode(bytes.slice(0,5)) !== "%PDF-")
    throw new Error("文件内容不是 PDF，请检查文件格式。");
  const task = getDocument({data:bytes,isEvalSupported:false,verbosity:0,
    cMapUrl:new URL("/assets/cmaps/",window.location.origin).href,cMapPacked:true});
  const abort = () => task.destroy();
  let timedOut = false;
  const timer = setTimeout(() => {timedOut = true; task.destroy();},30000);
  signal.addEventListener("abort",abort,{once:true});
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 25) throw new Error("一次最多导入 25 页 PDF，请拆分文件。");
    let text = "";
    const emptyPages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      signal.throwIfAborted();
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.filter(item => "str" in item)
        .map(item => item.str + (item.hasEOL ? "\n" : " ")).join("").trim();
      if (!pageText) emptyPages.push(i);
      text += pageText + "\n\n";
      if (text.length > MAX_EXTRACTED_CHARS) throw new Error("识别文字超过 50000 字，请拆分文件。");
      page.cleanup();
    }
    if (!text.trim()) throw new Error("PDF 没有识别到文字，可能是扫描版；请先做 OCR 或改用 DOCX / 文本。");
    const warnings = emptyPages.length ? ["第 " + emptyPages.join("、") + " 页未识别到文字；图片文字需 OCR，请核对遗漏。"] : [];
    return {text:text.trim(),warnings};
  } catch (error) {
    if (timedOut) throw new Error("文件识别超时，请精简文件或改用文本。");
    if (error.name === "PasswordException") throw new Error("PDF 已加密，请先解除密码后重试。");
    if (/^(文件|PDF|一次|识别)/.test(error.message ?? "")) throw error;
    throw new Error("无法解析 PDF，可能已损坏；请重新导出后重试。");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort",abort);
    await task.destroy();
  }
}
