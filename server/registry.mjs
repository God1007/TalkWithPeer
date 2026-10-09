import { mkdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { discoverNative, resolveModel } from "./catalog.mjs";
import {
  CodexAdapter,
  CursorAdapter,
  ReasonixAdapter,
} from "./native-adapters.mjs";
import { A2AAdapter, discoverA2A } from "./a2a-adapter.mjs";
import { ApiAdapter, discoverApi } from "./api-adapter.mjs";

export class AgentRegistry {
  constructor(store, root) {
    this.store = store;
    this.root = root;
    this.drivers = new Map();
    this.native = store.setting("native-providers", []);
  }
  list() {
    return [
      ...this.native,
      ...this.store.setting("a2a-providers", []),
      ...this.store.setting("api-providers", []),
    ];
  }
  async refresh() {
    this.native = await discoverNative(path.join(this.root, "catalog"));
    this.store.saveSetting("native-providers", this.native);
    return this.list();
  }
  provider(id) {
    return this.list().find((p) => p.id === id);
  }
  async addApi(input) {
    const provider = await discoverApi(input, {
      credentialRoot: path.join(this.root, "credentials"),
    });
    this.store.saveSetting("api-providers", [
      ...this.store.setting("api-providers", []),
      provider,
    ]);
    return provider;
  }
  async addA2A({ cardUrl, tokenEnv }) {
    const provider = {
      id: randomUUID(),
      ...(await discoverA2A(cardUrl, tokenEnv)),
    };
    this.store.saveSetting("a2a-providers", [
      ...this.store.setting("a2a-providers", []),
      provider,
    ]);
    return provider;
  }
  validateMember(input) {
    if (
      typeof input.providerId !== "string" ||
      typeof input.model !== "string" ||
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 80
    )
      throw new Error("Agent 配置不完整。");
    const provider = this.provider(input.providerId);
    if (!provider?.available) throw new Error("Agent 尚未就绪。");
    const parameters = input.parameters ?? {};
    if (
      !parameters ||
      typeof parameters !== "object" ||
      Array.isArray(parameters)
    )
      throw new Error("模型参数无效。");
    resolveModel(provider, { ...input, parameters });
    return {
      providerId: provider.id,
      model: input.model,
      parameters,
      name: input.name.trim(),
      petId: typeof input.petId === "string" ? input.petId : null,
    };
  }
  async driver(member, conversation) {
    const provider = this.provider(member.providerId);
    if (!provider) throw new Error("Agent 连接不存在。");
    const config = resolveModel(provider, member);
    const cwd =
      conversation.projectPath ??
      path.join(this.root, "projects", conversation.id, member.id);
    if (conversation.projectPath) {
      if (!(await stat(cwd)).isDirectory())
        throw new Error("所选项目目录已不可用。");
    } else await mkdir(cwd, { recursive: true });
    const fingerprint = JSON.stringify([
      member.providerId,
      config.model,
      config.parameters,
      cwd,
    ]);
    const cached = this.drivers.get(member.id);
    if (cached?.fingerprint === fingerprint) return cached.driver;
    cached?.driver.close();
    const options = {
      ...config,
      credentialRoot: path.join(this.root, "credentials"),
      localSession: provider.kind === "api" ? member.localSession : null,
    };
    const classes = {
      codex: CodexAdapter,
      cursor: CursorAdapter,
      reasonix: ReasonixAdapter,
    };
    const driver =
      provider.kind === "api"
        ? new ApiAdapter(provider, options)
        : provider.kind === "a2a"
          ? new A2AAdapter(provider, options)
          : new classes[provider.kind](cwd, options);
    this.drivers.set(member.id, { driver, fingerprint });
    return driver;
  }
  closeMember(id) {
    this.drivers.get(id)?.driver.close();
    this.drivers.delete(id);
  }
  close() {
    for (const entry of this.drivers.values()) entry.driver.close();
    this.drivers.clear();
  }
}
