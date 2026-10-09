import { readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateAgentUrl } from "./a2a-adapter.mjs";
import { API_PRESETS as presets } from "../shared/api-presets.mjs";

function credentialFile(provider, credentialRoot) {
  if (
    !credentialRoot ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      provider.id ?? "",
    )
  )
    throw new Error("本机凭证配置无效。");
  return path.join(credentialRoot, provider.id + ".key");
}
export async function apiKey(provider, credentialRoot) {
  if (provider.credentialSource === "local") {
    try {
      return await readFile(credentialFile(provider, credentialRoot), "utf8");
    } catch {
      throw new Error("本机 API 凭证不可用，请重新添加连接。");
    }
  }
  if (provider.credentialSource === "reasonix") {
    if (
      provider.baseUrl !== presets.deepseek.baseUrl ||
      provider.tokenEnv !== "DEEPSEEK_API_KEY"
    )
      throw new Error("Reasonix 凭证仅可用于官方 DeepSeek API。");
    const env = await readFile(
      path.join(os.homedir(), ".reasonix", ".env"),
      "utf8",
    );
    const line = env
      .split("\n")
      .find((line) => /^(?:export\s+)?DEEPSEEK_API_KEY\s*=/.test(line.trim()));
    const raw = line
      ?.trim()
      .replace(/^(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*/, "")
      .trim();
    const key = raw?.match(/^["'](.*)["']$/)?.[1] ?? raw;
    if (!key || /[\r\n]/.test(key))
      throw new Error("Reasonix 中未找到 DeepSeek API 凭证。");
    return key;
  }
  const key = process.env[provider.tokenEnv];
  if (!key) throw new Error("请设置环境变量：" + provider.tokenEnv);
  return key;
}
async function request(
  provider,
  endpoint,
  { body, signal, key: suppliedKey, credentialRoot } = {},
) {
  const headers = { "Content-Type": "application/json" };
  const key = suppliedKey ?? (await apiKey(provider, credentialRoot));
  if (provider.protocol === "messages") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else headers.Authorization = "Bearer " + key;
  const response = await fetch(provider.baseUrl + endpoint, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: signal ?? AbortSignal.timeout(30000),
  });
  // Provider error bodies can echo credentials or private prompts.
  if (!response.ok)
    throw new Error(
      provider.name + " 请求失败（HTTP " + response.status + "）。",
    );
  try {
    return await response.json();
  } catch {
    throw new Error(provider.name + " 返回的 JSON 格式无效。");
  }
}
export async function discoverApi(input, { credentialRoot } = {}) {
  const preset = presets[input.preset];
  if (!preset && !["chat", "responses", "messages"].includes(input.protocol))
    throw new Error("API 类型应为 chat、responses 或 messages。");
  const provider = {
    id: randomUUID(),
    kind: "api",
    ...(preset ?? {}),
    available: true,
    ...(preset
      ? {}
      : {
          name: input.name,
          protocol: input.protocol,
          baseUrl: input.baseUrl,
          tokenEnv: input.tokenEnv,
        }),
    credentialSource: input.credentialSource ?? "environment",
  };
  if (
    typeof provider.name !== "string" ||
    !provider.name.trim() ||
    provider.name.length > 80
  )
    throw new Error("API 名称无效。");
  const url = validateAgentUrl(provider.baseUrl);
  if (url.search || url.hash)
    throw new Error("API 基础地址不能包含查询或片段。");
  provider.baseUrl = url.href.replace(/\/$/, "");
  if (
    (provider.credentialSource !== "local" &&
      !/^[A-Z][A-Z0-9_]*$/.test(provider.tokenEnv ?? "")) ||
    !["environment", "reasonix", "local"].includes(provider.credentialSource)
  )
    throw new Error("凭证来源无效。");
  let key;
  if (provider.credentialSource === "local") {
    if (
      typeof input.apiKey !== "string" ||
      !input.apiKey.trim() ||
      input.apiKey.length > 8192 ||
      /[\r\n]/.test(input.apiKey)
    )
      throw new Error("请输入有效的 API Key。");
    credentialFile(provider, credentialRoot);
    key = input.apiKey.trim();
    provider.tokenEnv = null;
  }
  const result = await request(provider, "/models", { key, credentialRoot });
  if (!Array.isArray(result.data) || !result.data.length)
    throw new Error("API 未返回模型列表。");
  provider.models = result.data
    .filter((m) => typeof m.id === "string" && m.id.length <= 200)
    .slice(0, 500)
    .map((m) => ({
      id: m.id,
      name: m.display_name ?? m.id,
      parameters: [
        {
          id: "outputTokens",
          label: "最大输出 tokens",
          type: "number",
          min: 256,
          max: 32768,
          default: 4096,
        },
      ],
    }));
  if (!provider.models.length) throw new Error("API 模型列表无效。");
  if (key) {
    await mkdir(credentialRoot, { recursive: true, mode: 0o700 });
    await writeFile(credentialFile(provider, credentialRoot), key, {
      mode: 0o600,
      flag: "wx",
    });
  }
  return provider;
}
export class ApiAdapter {
  constructor(provider, options) {
    this.provider = provider;
    this.options = options;
    this.sessionId = null;
  }
  async run(prompt, _delta, activity, signal) {
    const { model, parameters } = this.options;
    const limit = parameters.outputTokens ?? 4096;
    activity({
      type: "request",
      text: "正在使用平台构建的上下文调用 " + this.provider.name,
    });
    let result, text, usage;
    if (this.provider.protocol === "responses") {
      result = await request(this.provider, "/responses", {
        credentialRoot: this.options.credentialRoot,
        signal,
        body: { model, input: prompt, store: false, max_output_tokens: limit },
      });
      if (result.status !== "completed")
        throw new Error("模型未完整完成回答，请调整输出上限后重试。");
      text = (result.output ?? [])
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text)
        .join("\n");
    } else if (this.provider.protocol === "messages") {
      result = await request(this.provider, "/messages", {
        credentialRoot: this.options.credentialRoot,
        signal,
        body: {
          model,
          max_tokens: limit,
          messages: [{ role: "user", content: prompt }],
        },
      });
      if (!["end_turn", "stop_sequence"].includes(result.stop_reason))
        throw new Error("模型未完整完成回答，请调整输出上限后重试。");
      text = (result.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    } else {
      result = await request(this.provider, "/chat/completions", {
        credentialRoot: this.options.credentialRoot,
        signal,
        body: {
          model,
          max_tokens: limit,
          messages: [{ role: "user", content: prompt }],
          stream: false,
        },
      });
      if (result.choices?.[0]?.finish_reason !== "stop")
        throw new Error("模型未完整完成回答，请调整输出上限后重试。");
      text = result.choices[0].message?.content;
    }
    if (typeof text !== "string" || !text.trim())
      throw new Error("模型没有返回公开文本。");
    usage = result.usage;
    return {
      text,
      model: result.model ?? model,
      sessionId: this.sessionId,
      usage,
    };
  }
  close() {}
}
