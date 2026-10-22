import {validateDocument} from "../shared/document-import.mjs";

export async function readDocument(file, signal) {
  const type = validateDocument(file);
  const buffer = await file.arrayBuffer();
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))]
    .map(byte => byte.toString(16).padStart(2,"0")).join("");
  signal.throwIfAborted();
  if (type === "pdf") {
    const {readPdf} = await import("./pdf-reader.mjs");
    signal.throwIfAborted();
    const result = await readPdf(buffer,signal);
    return {name:file.name,hash,...result};
  }
  return new Promise((resolve,reject) => {
    const worker = new Worker(new URL("./document-worker.mjs", import.meta.url), {type:"module"});
    const finish = (error,result) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
      else resolve({name:file.name,hash,...result});
    };
    const abort = () => finish(new Error("文件识别已取消。"));
    const timer = setTimeout(() => finish(new Error("文件识别超时，请精简文件或改用文本。")),30000);
    signal.addEventListener("abort", abort, {once:true});
    worker.onerror = () => finish(new Error("文件识别器加载失败，请刷新网页后重试。"));
    worker.onmessage = ({data}) => finish(data.error ? new Error(data.error) : null,data);
    worker.postMessage({type,buffer},[buffer]);
  });
}
