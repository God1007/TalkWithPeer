import { randomUUID } from "node:crypto";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from "@a2a-js/sdk/client";
import { Role, TaskState } from "@a2a-js/sdk";

export function validateAgentUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Agent 地址无效。");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (!local && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    /^(169\.254\.|100\.100\.100\.200|metadata\.)/.test(url.hostname)
  )
    throw new Error("Agent 需要 HTTPS 地址；本机 Agent 可以使用 HTTP。");
  return url;
}
export function agentFactory(cardUrl, tokenEnv) {
  const origin = validateAgentUrl(cardUrl).origin;
  if (tokenEnv && !/^[A-Z][A-Z0-9_]*$/.test(tokenEnv))
    throw new Error("认证环境变量名称无效。");
  const fetchImpl = (input, init = {}) => {
    const url = validateAgentUrl(
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url,
    );
    if (url.origin !== origin)
      throw new Error("Agent Card 的接口必须与发现地址同源。");
    const headers = new Headers(init.headers);
    if (tokenEnv) {
      const token = process.env[tokenEnv];
      if (!token) throw new Error("认证环境变量尚未设置：" + tokenEnv);
      headers.set("Authorization", "Bearer " + token);
    }
    return fetch(input, {
      ...init,
      headers,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(30000),
    });
  };
  const options = { fetchImpl, legacyCompat: { enabled: true } };
  return new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      cardResolver: new DefaultAgentCardResolver(options),
      transports: [
        new JsonRpcTransportFactory(options),
        new RestTransportFactory(options),
      ],
    }),
  );
}
export async function discoverA2A(cardUrl, tokenEnv) {
  const url = validateAgentUrl(cardUrl);
  const factory = agentFactory(cardUrl, tokenEnv);
  const client = await factory.createFromUrl(
    url.href,
    url.pathname === "/" ? undefined : "",
  );
  const card = await client.getAgentCard();
  for (const iface of card.supportedInterfaces) {
    if (validateAgentUrl(iface.url).origin !== url.origin)
      throw new Error("Agent Card 声明了不同来源的接口。");
  }
  const extension = card.capabilities?.extensions?.find(
    (e) => e.uri === "urn:talkwithpeer:model-config:1",
  )?.params;
  const models =
    Array.isArray(extension?.models) && extension.models.length <= 100
      ? extension.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          parameters: Array.isArray(m.parameters) ? m.parameters : [],
        }))
      : [{ id: "default", name: "Agent 默认模型", parameters: [] }];
  if (
    models.some((m) => typeof m.id !== "string" || !m.id || m.id.length > 200)
  )
    throw new Error("Agent 模型能力无效。");
  return {
    name: card.name,
    description: card.description,
    kind: "a2a",
    available: true,
    cardUrl: url.href,
    tokenEnv: tokenEnv ?? null,
    models,
    card,
  };
}
const partText = (parts) =>
  (parts ?? [])
    .map((p) =>
      p.content?.$case === "text"
        ? p.content.value
        : p.content?.$case === "data"
          ? JSON.stringify(p.content.value)
          : "",
    )
    .join("\n");
export class A2AAdapter {
  constructor(provider, options) {
    this.provider = provider;
    this.options = options;
    this.sessionId = options.localSession ?? null;
    this.client = null;
    this.taskId = null;
  }
  async run(prompt, onDelta, onActivity, signal) {
    this.taskId = null;
    this.running = true;
    if (!this.client)
      this.client = await agentFactory(
        this.provider.cardUrl,
        this.provider.tokenEnv,
      ).createFromAgentCard(this.provider.card);
    const request = {
      tenant: "",
      message: {
        messageId: randomUUID(),
        contextId: this.sessionId ?? "",
        taskId: "",
        role: Role.ROLE_USER,
        parts: [
          {
            content: { $case: "text", value: prompt },
            filename: "",
            mediaType: "text/plain",
          },
        ],
        extensions: [],
        referenceTaskIds: [],
      },
      metadata: {
        talkwithpeer: {
          model: this.options.model,
          parameters: this.options.parameters,
        },
      },
      configuration: {
        acceptedOutputModes: ["text/plain", "application/json"],
        returnImmediately: false,
      },
    };
    const artifacts = new Map();
    let direct = "",
      completed = false;
    const cancel = () => {
      if (this.taskId)
        this.client
          .cancelTask(
            { id: this.taskId, tenant: "" },
            { signal: AbortSignal.timeout(5000) },
          )
          .catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      for await (const wrapper of this.client.sendMessageStream(request, {
        signal,
      })) {
        const item = wrapper.payload?.value;
        const kind = wrapper.payload?.$case;
        if (!item) continue;
        if (item.contextId) this.sessionId = item.contextId;
        if (kind === "message") {
          direct = partText(item.parts);
          onDelta(direct);
          completed = true;
        }
        if (kind === "task") {
          this.taskId = item.id;
          for (const artifact of item.artifacts ?? [])
            artifacts.set(artifact.artifactId, partText(artifact.parts));
          if (item.status?.state === TaskState.TASK_STATE_COMPLETED)
            completed = true;
          if (
            [
              TaskState.TASK_STATE_FAILED,
              TaskState.TASK_STATE_REJECTED,
              TaskState.TASK_STATE_CANCELED,
              TaskState.TASK_STATE_AUTH_REQUIRED,
              TaskState.TASK_STATE_INPUT_REQUIRED,
            ].includes(item.status?.state)
          )
            throw new Error("A2A Agent 需要处理任务状态：" + item.status.state);
        }
        if (kind === "artifactUpdate" && item.artifact) {
          const text = partText(item.artifact.parts);
          artifacts.set(
            item.artifact.artifactId,
            item.append
              ? (artifacts.get(item.artifact.artifactId) ?? "") + text
              : text,
          );
          onDelta(text);
        }
        if (kind === "statusUpdate") {
          this.taskId = item.taskId;
          if (item.status?.message)
            onActivity(partText(item.status.message.parts));
          if (item.status?.state === TaskState.TASK_STATE_COMPLETED)
            completed = true;
          if (
            [
              TaskState.TASK_STATE_FAILED,
              TaskState.TASK_STATE_REJECTED,
              TaskState.TASK_STATE_CANCELED,
              TaskState.TASK_STATE_AUTH_REQUIRED,
              TaskState.TASK_STATE_INPUT_REQUIRED,
            ].includes(item.status?.state)
          )
            throw new Error("A2A Agent 未完成本轮任务。");
        }
      }
      const text = [...artifacts.values()].join("\n") || direct;
      if (!completed || !text.trim())
        throw new Error("A2A Agent 未返回完整结果。");
      return { text, sessionId: this.sessionId, model: this.options.model };
    } finally {
      this.running = false;
      signal.removeEventListener("abort", cancel);
    }
  }
  close() {
    if (this.running && this.taskId && this.client)
      this.client
        .cancelTask(
          { id: this.taskId, tenant: "" },
          { signal: AbortSignal.timeout(5000) },
        )
        .catch(() => {});
  }
}
