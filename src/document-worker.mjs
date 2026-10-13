import mammoth from "mammoth/mammoth.browser.js";
import {decodeDocumentText, MAX_EXTRACTED_CHARS} from "../shared/document-import.mjs";

self.onmessage = async ({data:{type,buffer}}) => {
  try {
    let text = "", warnings = [];
    const bytes = new Uint8Array(buffer);
    if (type === "docx") {
      const result = await mammoth.extractRawText({arrayBuffer:buffer}, {externalFileAccess:false});
      text = result.value;
      warnings.push("DOCX 的图片、页眉页脚和复杂排版可能未提取，请核对预览。");
      if (result.messages.length) warnings.push("文档解析有 " + result.messages.length + " 项提示，请重点核对特殊内容。");
    } else {
      text = decodeDocumentText(bytes);
    }
    if (!text.trim()) throw new Error("文件未识别到可导入的文字。");
    if (text.length > MAX_EXTRACTED_CHARS) throw new Error("识别文字超过 50000 字，请拆分文件。");
    self.postMessage({text:text.trim(),warnings});
  } catch (error) {
    const message = /^(文件|文本|识别)/.test(error?.message ?? "") ? error.message :
      "无法解析文件，可能已损坏或格式不匹配；请重新导出 DOCX 后重试。";
    self.postMessage({error:message});
  }
};
