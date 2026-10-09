import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateAgentUrl } from "./a2a-adapter.mjs";

const presets = {
  deepseek: {
    name: "DeepSeek API",
    protocol: "chat",
    baseUrl: "https://api.deepseek.com",
    tokenEnv: "DEEPSEEK_API_KEY",
  },
  openai: {
    name: "OpenAI API",
    protocol: "responses",
    baseUrl: "https://api.openai.com/v1",
    tokenEnv: "OPENAI_API_KEY",
  },
  anthropic: {
    name: "Anthropic API",
    protocol: "messages",
    baseUrl: "https://api.anthropic.com/v1",
    tokenEnv: "ANTHROPIC_API_KEY",
  },
};
export async function apiKey(provider) {
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
async function request(provider, endpoint, { body, signal } = {}) {
  const headers = { "Content-Type": "application/json" };
  const key = await apiKey(provider);
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
  return response.json();
}
export async function discoverApi(input) {
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
    !/^[A-Z][A-Z0-9_]*$/.test(provider.tokenEnv ?? "") ||
    !["environment", "reasonix"].includes(provider.credentialSource)
  )
    throw new Error("凭证来源无效。");
  const result = await request(provider, "/models");
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
