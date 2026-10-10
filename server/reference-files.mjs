import { readFile, readdir, lstat, realpath, readlink } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const secretKey =
  /secret|password|api[_-]?key|authorization|(?:^|_)token$|cookie|jwt/i;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function redactReference(text) {
  let redacted = false;
  const hide = () => {
    redacted = true;
    return "[REDACTED]";
  };
  try {
    const value = JSON.parse(text);
    const walk = (object) => {
      if (!object || typeof object !== "object") return;
      for (const [key, value] of Object.entries(object)) {
        if (
          secretKey.test(key) &&
          typeof value === "string" &&
          value &&
          !/^\$\{[^}]+\}$/.test(value)
        )
          object[key] = hide();
        else walk(value);
      }
    };
    walk(value);
    if (redacted) text = JSON.stringify(value, null, 2) + "\n";
  } catch {}
  text = text
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, hide)
    .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, hide)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, hide)
    .replace(
      /((?:[A-Z_]*(?:SECRET|PASSWORD|TOKEN|API_KEY)[A-Z_]*|Authorization)["']?\s*[:=]\s*)["']([^"'\r\n]+)["']/gi,
      (match, prefix, value) =>
        /^\$/.test(value) ? match : prefix + '"' + hide() + '"',
    );
  return { content: text, redacted };
}

export async function referenceFiles(library, sources) {
  if (
    !Array.isArray(sources) ||
    !sources.length ||
    sources.length > 20 ||
    sources.some(
      (p) =>
        typeof p !== "string" ||
        !p.startsWith("source/") ||
        p.split("/").some((s) => !s || s === "." || s === ".."),
    )
  )
    throw new Error("资料源必须位于本库 source/ 内。");
  const root = await realpath(library.root);
  const files = [],
    seen = new Set();
  let total = 0;
  const walk = async (filename, depth = 0) => {
    if (depth > 12) throw new Error("资料目录层级过深。");
    const relative = path.relative(root, filename);
    if (seen.has(relative)) return;
    seen.add(relative);
    const info = await lstat(filename);
    if (!info.isSymbolicLink()) {
      const actual = await realpath(filename);
      if (!actual.startsWith(root + path.sep))
        throw new Error("资料源越过本机扩展库。");
    }
    if (info.isSymbolicLink()) {
      const target = await readlink(filename);
      files.push({
        path: relative,
        content: "[符号链接，仅审查链接文本] " + target,
        encoding: "symlink",
        sha256: hash(target),
        size: Buffer.byteLength(target),
      });
    } else if (info.isDirectory()) {
      for (const name of (await readdir(filename)).sort()) {
        if ([".git", ".DS_Store", "node_modules"].includes(name)) continue;
        await walk(path.join(filename, name), depth + 1);
      }
    } else {
      if (!info.isFile() || info.size > 1024 * 1024)
        throw new Error("资料文件须不超过1MB。");
      if (
        /(?:^|\/)(?:\.env(?:\.[^/]*)?|credentials[^/]*|[^/]*\.(?:pem|key|p12))(?=\/|$)/i.test(
          relative,
        )
      )
        throw new Error("资料包不读取凭证文件。");
      const bytes = await readFile(filename);
      total += bytes.length;
      if (bytes.length > 1024 * 1024 || total > 8 * 1024 * 1024)
        throw new Error("资料包超过8MB。");
      const metadata = {
        path: relative,
        sha256: hash(bytes),
        size: bytes.length,
      };
      try {
        if (bytes.includes(0)) throw new Error("binary");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        files.push({ ...metadata, encoding: "utf8", ...redactReference(text) });
      } catch {
        files.push({
          ...metadata,
          encoding: "binary",
          content: "[二进制资料，仅显示大小与哈希，不执行]",
        });
      }
    }
    if (files.length > 512) throw new Error("资料包最多512个文件。");
  };
  for (const source of sources) {
    let filename = root;
    for (const part of source.split("/")) {
      filename = path.join(filename, part);
      const info = await lstat(filename);
      if (info.isSymbolicLink() && filename !== path.join(root, source))
        throw new Error("资料目录不能通过符号链接跳转。");
    }
    await walk(filename);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
