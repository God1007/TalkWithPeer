import {readdirSync,readFileSync} from "node:fs";
import {defineConfig} from "vite";

export default defineConfig({plugins:[{
  name:"local-pdf-cmaps",
  generateBundle() {
    const root = new URL("./node_modules/pdfjs-dist/cmaps/",import.meta.url);
    for (const name of readdirSync(root).filter(name => name.endsWith(".bcmap") || name === "LICENSE"))
      this.emitFile({type:"asset",fileName:"assets/cmaps/"+name,source:readFileSync(new URL(name,root))});
    // The existing static server serves .js modules; keep the worker local and compatible.
    this.emitFile({type:"asset",fileName:"assets/pdf-worker.js",source:readFileSync(new URL("./node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",import.meta.url))});
  }
}]});
