import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import Markdown from "react-markdown";
import {
  Plus,
  ChatCircle,
  GearSix,
  DotsThree,
  FolderSimple,
  Check,
  X,
  PawPrint,
  SlidersHorizontal,
  LinkSimple,
  ArrowsClockwise,
  Stop,
  ArrowUp,
  CaretLeft,
  CaretDown,
  Copy,
  Robot,
  WarningCircle,
  CheckCircle,
  GitBranch,
} from "@phosphor-icons/react";
import "./style.css";
import { API_PRESETS } from "../shared/api-presets.mjs";

const effortLabels = {
  auto: "自动",
  disabled: "关闭",
  none: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "更高",
  max: "最高",
  ultra: "极高",
};
const stanceLabels = { accept: "接受", revise: "修订", reject: "拒绝" };
const stanceName = (vote) =>
  vote?.stance === "accept" && vote.acceptsSolution === false
    ? "认可记录"
    : stanceLabels[vote?.stance];
const stateLabels = {
  idle: "",
  running: "讨论中",
  paused: "已暂停",
  consensus: "达成共识",
  deadlock: "保留分歧",
};
async function api(url, method = "GET", body) {
  const response = await fetch("/api" + url, {
    method,
    headers:
      method === "GET"
        ? undefined
        : { "Content-Type": "application/json", "X-TWP": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error("本机服务尚未连接。");
  }
  if (!response.ok) throw new Error(value.error ?? "请求未完成。");
  return value;
}
function IconButton({ label, children, className = "", ...props }) {
  return (
    <button
      className={"icon-button " + className}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}
function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
function Pet({ pet, status = "idle", size = 60 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!pet || !ref.current) return;
    const requested =
      {
        thinking: 7,
        reviewing: 8,
        paused: 6,
        failed: 5,
        consensus: 3,
        deadlock: 6,
      }[status] ?? 0;
    const row = pet.frames[requested] ? requested : 0;
    const count = pet.frames[row] || 1;
    const scale = size / 192;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer;
    let frame = 0;
    const draw = () => {
      if (ref.current)
        ref.current.style.backgroundPosition =
          -frame * size + "px " + -row * 208 * scale + "px";
    };
    const start = () => {
      clearInterval(timer);
      frame = 0;
      draw();
      if (!motion.matches && count > 1)
        timer = setInterval(
          () => {
            frame = (frame + 1) % count;
            draw();
          },
          status === "idle" ? 170 : 125,
        );
    };
    start();
    motion.addEventListener("change", start);
    return () => {
      clearInterval(timer);
      motion.removeEventListener("change", start);
    };
  }, [pet?.id, status, size]);
  if (!pet)
    return (
      <span
        className={"pet-fallback " + status}
        style={{ width: size, height: (size * 208) / 192 }}
      >
        <PawPrint size={size * 0.56} weight="duotone" />
      </span>
    );
  return (
    <span
      ref={ref}
      className="pet-sprite"
      aria-hidden="true"
      style={{
        width: size,
        height: (size * 208) / 192,
        backgroundImage: "url(/api/pets/" + pet.id + "/sprite)",
        backgroundSize:
          (pet.width * size) / 192 + "px " + (pet.height * size) / 192 + "px",
      }}
    />
  );
}
function Modal({ title, description, children, onClose, wide = false }) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className={"modal " + (wide ? "wide" : "")}>
          <div className="modal-header">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="关闭">
                <X size={18} />
              </IconButton>
            </Dialog.Close>
          </div>
          <Dialog.Description
            className={description ? "modal-description" : "sr-only"}
          >
            {description ?? title}
          </Dialog.Description>
          <div className="modal-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function ErrorLine({ error }) {
  return error ? (
    <div className="error-line" role="alert">
      <WarningCircle size={17} />
      <span>{error}</span>
    </div>
  ) : null;
}
function FormButtons({ busy, label, onClose }) {
  return (
    <div className="form-buttons">
      <button className="button secondary" type="button" onClick={onClose}>
        取消
      </button>
      <button className="button primary" disabled={busy}>
        {busy ? "保存中…" : label}
      </button>
    </div>
  );
}
function AgentForm({
  providers,
  pets,
  codexPets,
  member,
  onSave,
  onClose,
  onPetImport,
}) {
  const [providerId, setProviderId] = useState(
    member?.providerId ?? providers.find((p) => p.models.length)?.id ?? "",
  );
  const provider = providers.find((p) => p.id === providerId);
  const preferred = (p) =>
    p.models.find(
      (m) =>
        m.id === "gpt-6.1-sol" ||
        m.id === "claude-opus-5-5-medium" ||
        m.id === "deepseek-pro/deepseek-v4-pro",
    ) ??
    p.models.find((m) => m.default) ??
    p.models[0];
  const [model, setModel] = useState(
    member?.model ?? (provider ? preferred(provider)?.id : ""),
  );
  const [name, setName] = useState(member?.name ?? provider?.name ?? "");
  const [parameters, setParameters] = useState(member?.parameters ?? {});
  const [capacity, setCapacity] = useState(member?.capacity ?? {});
  const [petId, setPetId] = useState(
    member?.petId ??
      pets[0]?.id ??
      (codexPets[0] ? "codex:" + codexPets[0].id : ""),
  );
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const modelInfo = provider?.models.find((m) => m.id === model);
  const changeProvider = (id) => {
    const p = providers.find((p) => p.id === id);
    setProviderId(id);
    setModel(preferred(p)?.id ?? "");
    setName(p.name);
    setParameters({});
    setCapacity({});
  };
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          let selected = petId;
          if (petId.startsWith("codex:"))
            selected = (await onPetImport(petId.slice(6))).id;
          await onSave({
            providerId,
            model,
            name,
            parameters,
            petId: selected || null,
            capacity,
          });
          onClose();
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        Agent
        <select
          value={providerId}
          disabled={!!member}
          onChange={(e) => changeProvider(e.target.value)}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.models.length}>
              {p.name}
              {p.models.length ? "" : " · 需要配置"}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        名称
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          required
        />
      </label>
      <label className="field">
        模型
        <select
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            setParameters({});
            setCapacity({});
          }}
          required
        >
          <option value="" disabled>
            选择模型
          </option>
          {provider?.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      {(modelInfo?.parameters ?? []).map((parameter) => (
        <label className="field" key={parameter.id}>
          {parameter.label}
          {parameter.type === "number" ? (
            <input
              type="number"
              min={parameter.min}
              max={parameter.max}
              step="1"
              value={parameters[parameter.id] ?? parameter.default ?? ""}
              onChange={(e) =>
                setParameters({
                  ...parameters,
                  [parameter.id]: Number(e.target.value),
                })
              }
            />
          ) : (
            <select
              value={parameters[parameter.id] ?? parameter.default ?? ""}
              onChange={(e) =>
                setParameters({ ...parameters, [parameter.id]: e.target.value })
              }
            >
              {parameter.options.map((value) => (
                <option key={value} value={value}>
                  {effortLabels[value] ?? value}
                </option>
              ))}
            </select>
          )}
        </label>
      ))}
      <label className="field">
        Pet
        <select value={petId} onChange={(e) => setPetId(e.target.value)}>
          <option value="">默认图标</option>
          {pets.length > 0 && (
            <optgroup label="已导入">
              {pets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
          {codexPets.length > 0 && (
            <optgroup label="Codex 本机">
              {codexPets.map((p) => (
                <option key={p.id} value={"codex:" + p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <details className="capacity-options">
        <summary>上下文容量</summary>
        <p className="subtle">
          窗口留空表示未知；输出预留不会低于 API
          实际配置的最大输出。原生工具开销可通过额外预留配置。
        </p>
        {[
          ["windowTokens", "模型窗口", 1024, 4000000],
          ["outputReserve", "输出预留", 256, 65536],
          ["extraReserve", "额外推理 / 工具预留", 0, 65536],
          ["safetyReserve", "安全余量", 0, 16384],
        ].map(([key, label, min, max]) => (
          <label className="field" key={key}>
            {label}
            <input
              type="number"
              min={min}
              max={max}
              step="1"
              placeholder={key === "windowTokens" ? "未知" : "使用默认值"}
              value={capacity[key] ?? ""}
              onChange={(e) =>
                setCapacity({
                  ...capacity,
                  [key]: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
          </label>
        ))}
      </details>
      <ErrorLine error={error} />
      <FormButtons
        busy={busy}
        label={member ? "保存配置" : "添加参与者"}
        onClose={onClose}
      />
    </form>
  );
}
function ProjectPicker({ selected, onSave, onClose }) {
  const [browse, setBrowse] = useState(null);
  const [input, setInput] = useState(selected ?? "");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useCallback(async (value) => {
    setError(null);
    setBusy(true);
    try {
      const result = await api(
        "/projects/browse" +
          (value ? "?path=" + encodeURIComponent(value) : ""),
      );
      setBrowse(result);
      setInput(result.path);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    navigate(selected);
  }, [navigate, selected]);
  return (
    <>
      <form
        className="path-form"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(input);
        }}
      >
        <input
          aria-label="项目目录路径"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="本地项目目录"
        />
        <button className="button secondary" disabled={busy}>
          打开
        </button>
      </form>
      <div className="folder-list">
        {browse && (
          <button
            className="folder-row parent"
            onClick={() => navigate(browse.parent)}
          >
            <CaretLeft size={16} />
            上一级
          </button>
        )}
        {browse?.directories.map((folder) => (
          <button
            className="folder-row"
            key={folder.path}
            onClick={() => navigate(folder.path)}
          >
            <FolderSimple size={19} />
            <span>{folder.name}</span>
          </button>
        ))}
        {browse && !browse.directories.length && (
          <p className="subtle">此目录没有子文件夹。</p>
        )}
      </div>
      <ErrorLine error={error} />
      <div className="form-buttons">
        <button
          className="button secondary"
          onClick={async () => {
            try {
              await onSave(null);
              onClose();
            } catch (e) {
              setError(e.message);
            }
          }}
        >
          不使用项目
        </button>
        <button
          className="button primary"
          disabled={busy || !browse}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave(browse.path);
              onClose();
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          选择此项目
        </button>
      </div>
    </>
  );
}
function PetManager({ pets, codexPets, onImport, onClose }) {
  const [tab, setTab] = useState("library");
  const [link, setLink] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const importPet = async (body) => {
    setBusy(body.id ?? "link");
    setError(null);
    try {
      await onImport(body);
      setTab("library");
      setLink("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div className="tabs">
        {[
          ["library", "已导入"],
          ["codex", "Codex 本机"],
          ["link", "安装链接"],
        ].map(([value, label]) => (
          <button
            key={value}
            className={tab === value ? "selected" : ""}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "library" && (
        <div className="pet-library">
          {pets.map((p) => (
            <div className="pet-library-item" key={p.id}>
              <Pet pet={p} size={72} />
              <strong>{p.name}</strong>
            </div>
          ))}
          {!pets.length && <div className="empty-small">还没有导入 pet。</div>}
        </div>
      )}
      {tab === "codex" && (
        <div className="connection-list">
          {codexPets.map((p) => (
            <div className="connection-row" key={p.id}>
              <PawPrint size={22} />
              <div>
                <strong>{p.name}</strong>
                <span>Sprite v{p.version}</span>
              </div>
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() => importPet({ source: "codex", id: p.id })}
              >
                {busy === p.id ? "导入中…" : "导入"}
              </button>
            </div>
          ))}
          {!codexPets.length && (
            <div className="empty-small">没有发现本机 Codex pet。</div>
          )}
        </div>
      )}
      {tab === "link" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            importPet({ source: "link", link });
          }}
        >
          <label className="field">
            Codex pet 安装链接
            <textarea
              rows={4}
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="codex://pets/install?name=…&imageUrl=…"
              required
            />
          </label>
          <div className="form-buttons">
            <button
              type="button"
              className="button secondary"
              onClick={onClose}
            >
              关闭
            </button>
            <button className="button primary" disabled={!!busy}>
              {busy ? "导入中…" : "导入 pet"}
            </button>
          </div>
        </form>
      )}
      <ErrorLine error={error} />
    </>
  );
}
function ConnectionForm({ onSave, onClose }) {
  const [kind, setKind] = useState("api");
  const [preset, setPreset] = useState("deepseek");
  const [config, setConfig] = useState(API_PRESETS.deepseek);
  const [credentialSource, setCredentialSource] = useState("local");
  const [key, setKey] = useState("");
  const [cardUrl, setCardUrl] = useState("");
  const [tokenEnv, setTokenEnv] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSave(
            kind === "a2a"
              ? { cardUrl, tokenEnv: tokenEnv || null }
              : {
                  kind: "api",
                  ...config,
                  credentialSource,
                  ...(credentialSource === "local" ? { apiKey: key } : {}),
                },
          );
          setKey("");
          onClose();
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset className="connection-fields" disabled={busy}>
        <div className="tabs">
          {[
            ["api", "模型 API"],
            ["a2a", "A2A Agent"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              className={kind === value ? "selected" : ""}
              onClick={() => {
                setKind(value);
                setKey("");
                setError(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {kind === "api" ? (
          <>
            <label className="field">
              服务商
              <select
                value={preset}
                onChange={(e) => {
                  setPreset(e.target.value);
                  setConfig(
                    API_PRESETS[e.target.value] ?? {
                      name: "",
                      protocol: "chat",
                      baseUrl: "",
                      tokenEnv: "MODEL_API_KEY",
                    },
                  );
                  setKey("");
                  setCredentialSource("local");
                  setError(null);
                }}
              >
                <option value="deepseek">DeepSeek</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="custom">自定义 API</option>
              </select>
            </label>
            <label className="field">
              连接名称
              <input
                required
                maxLength={80}
                value={config.name}
                onChange={(e) => setConfig({ ...config, name: e.target.value })}
              />
            </label>
            <label className="field">
              API 协议
              <select
                value={config.protocol}
                onChange={(e) =>
                  setConfig({ ...config, protocol: e.target.value })
                }
              >
                <option value="chat">Chat Completions（OpenAI 兼容）</option>
                <option value="responses">OpenAI Responses</option>
                <option value="messages">Anthropic Messages</option>
              </select>
            </label>
            <label className="field">
              API 基础地址
              <input
                type="url"
                required
                value={config.baseUrl}
                placeholder="https://example.com/v1"
                onChange={(e) => {
                  setConfig({ ...config, baseUrl: e.target.value });
                  setKey("");
                  setCredentialSource("local");
                }}
              />
            </label>
            <label className="field">
              认证方式
              <select
                value={credentialSource}
                onChange={(e) => {
                  setCredentialSource(e.target.value);
                  setKey("");
                }}
              >
                <option value="local">填写 API Key</option>
                <option value="environment">使用环境变量</option>
                {config.baseUrl === API_PRESETS.deepseek.baseUrl && (
                  <option value="reasonix">
                    使用本机 Reasonix 的 DeepSeek 凭证
                  </option>
                )}
              </select>
            </label>
            {credentialSource === "local" ? (
              <label className="field">
                API Key
                <input
                  type="password"
                  required
                  maxLength={8192}
                  autoComplete="new-password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="输入 API Key"
                />
                <span className="subtle">
                  仅保存在本机凭证文件，连接后不再回显。
                </span>
              </label>
            ) : credentialSource === "environment" ? (
              <label className="field">
                密钥环境变量
                <input
                  required
                  pattern="[A-Z][A-Z0-9_]*"
                  value={config.tokenEnv}
                  onChange={(e) =>
                    setConfig({ ...config, tokenEnv: e.target.value })
                  }
                />
                <span className="subtle">使用启动本机服务时的环境变量。</span>
              </label>
            ) : (
              <p className="subtle">
                从本机 Reasonix 读取 DeepSeek 凭证，仅用于官方 DeepSeek 地址。
              </p>
            )}
            <p className="subtle">
              连接时发现可用模型，随后可添加为讨论参与者。
            </p>
          </>
        ) : (
          <>
            <label className="field">
              Agent Card 地址
              <input
                type="url"
                placeholder="https://…/.well-known/agent-card.json"
                value={cardUrl}
                onChange={(e) => setCardUrl(e.target.value)}
                required
              />
            </label>
            <label className="field">
              认证环境变量 <span className="optional">可选</span>
              <input
                value={tokenEnv}
                onChange={(e) => setTokenEnv(e.target.value)}
                placeholder="A2A_AGENT_TOKEN"
                pattern="[A-Z][A-Z0-9_]*"
              />
            </label>
          </>
        )}
      </fieldset>
      <ErrorLine error={error} />
      <FormButtons
        busy={busy}
        label={busy ? "正在连接…" : "添加连接"}
        onClose={onClose}
      />
    </form>
  );
}
function ContextPanel({
  conversationId,
  members,
  running,
  revision,
  onChange,
}) {
  const [data, setData] = useState(null),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false);
  const [goal, setGoal] = useState(""),
    [constraints, setConstraints] = useState(""),
    [budget, setBudget] = useState(24000);
  const [auto, setAuto] = useState(true),
    [rebase, setRebase] = useState(false),
    [request, setRequest] = useState(null);
  const refresh = useCallback(async () => {
    const value = await api("/conversations/" + conversationId + "/context");
    setData(value);
    setGoal(value.projection.task.goal?.text ?? "");
    setConstraints(
      value.projection.task.constraints.map((c) => c.text).join("\n"),
    );
    setBudget(value.state.budget);
    setAuto(value.state.auto);
  }, [conversationId]);
  useEffect(() => {
    let disposed = false;
    refresh().catch((e) => {
      if (!disposed) setError(e.message);
    });
    return () => {
      disposed = true;
    };
  }, [refresh, revision]);
  const perform = async (action) => {
    setError(null);
    setBusy(true);
    try {
      await action();
      await refresh();
      await onChange();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (!data) return <ErrorLine error={error} />;
  const latest = data.requests.filter((r) => r.phase !== "compaction").at(-1);
  const checkpoint = data.projection.checkpoint;
  return (
    <section className="context-console" aria-label="Agent 上下文">
      <div className="pane-heading">
        <div>
          <span className="eyebrow">AGENT RUNTIME</span>
          <h2>上下文与记忆</h2>
        </div>
        <span className="runtime-badge">v{data.projection.version}</span>
      </div>
      <div className="runtime-metrics">
        <article>
          <span>固定约束</span>
          <strong>{data.projection.task.constraints.length}</strong>
          <small>任务版本 {data.projection.task.revision}</small>
        </article>
        <article>
          <span>共享 / 成员 memo</span>
          <strong>{data.state.notes.length}</strong>
          <small>按身份注入</small>
        </article>
        <article>
          <span>Checkpoint</span>
          <strong>{data.state.checkpoints.length}</strong>
          <small>原始记录保留</small>
        </article>
        <article>
          <span>最近输入 tokens</span>
          <strong>{latest?.measured.tokens.toLocaleString() ?? "—"}</strong>
          <small>
            {latest?.measured.method === "provider"
              ? "供应方计数"
              : latest
                ? "估算 · 来源见审计"
                : "尚未调用"}
          </small>
        </article>
      </div>
      <details className="runtime-section">
        <summary>目标与固定约束</summary>
        <p className="subtle">
          原始用户指令在压缩后仍保留。此处的固定约束由用户管理，模型摘要不能修改。
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            perform(() =>
              api("/conversations/" + conversationId + "/task", "PATCH", {
                goal,
                constraints: constraints
                  .split("\n")
                  .map((t) => t.trim())
                  .filter(Boolean),
                rebase,
              }),
            );
          }}
        >
          <label className="field">
            任务目标
            <textarea
              rows={3}
              required
              maxLength={12000}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              disabled={running || busy}
            />
          </label>
          <label className="field">
            固定约束（每行一条）
            <textarea
              rows={3}
              value={constraints}
              onChange={(e) => setConstraints(e.target.value)}
              disabled={running || busy}
            />
          </label>
          <label className="runtime-check">
            <input
              type="checkbox"
              checked={rebase}
              onChange={(e) => setRebase(e.target.checked)}
              disabled={running || busy}
            />
            重设旧用户指令的生效边界
          </label>
          <button className="button secondary" disabled={running || busy}>
            保存任务
          </button>
        </form>
      </details>
      <details className="runtime-section">
        <summary>容量与压缩策略</summary>
        <form
          className="runtime-policy"
          onSubmit={(e) => {
            e.preventDefault();
            perform(() =>
              api("/conversations/" + conversationId + "/context", "PATCH", {
                budget: Number(budget),
                auto,
              }),
            );
          }}
        >
          <label className="field">
            平台输入预算
            <input
              type="number"
              min={4000}
              max={128000}
              step={1}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              disabled={running || busy}
            />
          </label>
          <label className="runtime-check">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
              disabled={running || busy}
            />
            超限时自动压缩
          </label>
          <button className="button secondary" disabled={running || busy}>
            保存策略
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={running || busy || !members.length}
            onClick={() =>
              perform(() =>
                api("/conversations/" + conversationId + "/compact", "POST", {
                  memberId: members[0].id,
                }),
              )
            }
          >
            压缩旧记录
          </button>
        </form>
        <div className="capacity-list">
          {data.capacities.map((c) => (
            <article key={c.memberId}>
              <strong>{c.name}</strong>
              <span>可用输入 {c.inputLimit.toLocaleString()}</span>
              <small>
                {c.windowTokens
                  ? "窗口 " +
                    c.windowTokens.toLocaleString() +
                    " · " +
                    (c.windowSource === "user" ? "用户配置" : "供应方")
                  : "窗口未知"}
                {" · 输出预留 " +
                  c.outputReserve +
                  " · 额外预留 " +
                  c.extraReserve +
                  " · 安全余量 " +
                  c.safetyReserve}
              </small>
            </article>
          ))}
        </div>
      </details>
      {checkpoint && (
        <details className="runtime-section">
          <summary>
            最近压缩摘要 · {checkpoint.coverageCount} 条覆盖记录
          </summary>
          <p className="subtle">模型转述，引用可核对；不作为投票或用户约束。</p>
          <Markdown>{checkpoint.summary}</Markdown>
          {["facts", "decisions", "unresolved"].map((key) => (
            <div key={key}>
              <h4>
                {
                  {
                    facts: "有来源的陈述",
                    decisions: "共识记录",
                    unresolved: "未决问题",
                  }[key]
                }
              </h4>
              {checkpoint[key].map((item, index) => (
                <blockquote key={index}>
                  <p>{item.text}</p>
                  <q>{item.quote}</q>
                  <code>{item.sourceId}</code>
                </blockquote>
              ))}
            </div>
          ))}
        </details>
      )}
      <details className="runtime-section" open>
        <summary>请求审计 · {data.requests.length} 次调用</summary>
        <p className="subtle">
          每次实际输入独立保存；私有 memo
          只发给所属成员。哈希用于核对平台发送内容。
        </p>
        <div className="request-list">
          {data.requests
            .slice(-12)
            .reverse()
            .map((r) => (
              <button
                key={r.id}
                onClick={async () => {
                  try {
                    setRequest(
                      (
                        await api(
                          "/conversations/" +
                            conversationId +
                            "/requests/" +
                            r.id,
                        )
                      ).request,
                    );
                  } catch (e) {
                    setError(e.message);
                  }
                }}
              >
                <span>
                  <strong>
                    {members.find((m) => m.id === r.memberId)?.name ?? r.model}
                  </strong>
                  <small>
                    {r.phase} · {r.status}
                  </small>
                </span>
                <span>
                  {r.measured.tokens.toLocaleString()} tokens
                  <code>{r.inputHash.slice(0, 10)}</code>
                </span>
              </button>
            ))}
        </div>
        {!data.requests.length && (
          <p className="empty-small">讨论开始后显示实际请求。</p>
        )}
        {request && (
          <div className="request-inspector">
            <div className="pane-heading">
              <strong>实际发送的输入</strong>
              <button className="text-button" onClick={() => setRequest(null)}>
                收起
              </button>
            </div>
            <p className="subtle">
              {request.model} · {request.measured.method} · 预算{" "}
              {request.capacity.inputLimit}
            </p>
            <code className="request-hash">{request.inputHash}</code>
            <pre>{request.input}</pre>
          </div>
        )}
      </details>
      <ErrorLine error={error} />
    </section>
  );
}
function TraceView({ detail, member, pet }) {
  const [tab, setTab] = useState("progress");
  return (
    <>
      <div className="member-profile">
        <Pet pet={pet} size={78} />
        <div>
          <strong>{member.name}</strong>
          <p>{member.model}</p>
        </div>
      </div>
      <div className="local-session">
        <span>Local session</span>
        <code>{detail?.member.localSession ?? "等待首次连接"}</code>
        {detail?.member.localSession && (
          <IconButton
            label="复制会话标识"
            onClick={() =>
              navigator.clipboard.writeText(detail.member.localSession)
            }
          >
            <Copy size={16} />
          </IconButton>
        )}
      </div>
      <div className="tabs">
        <button
          className={tab === "progress" ? "selected" : ""}
          onClick={() => setTab("progress")}
        >
          过程
        </button>
        <button
          className={tab === "messages" ? "selected" : ""}
          onClick={() => setTab("messages")}
        >
          公开对话
        </button>
      </div>
      {tab === "progress" ? (
        <div className="trace-list">
          {detail?.events.map((e) => (
            <article className={"trace-item " + e.type} key={e.id}>
              <div className="trace-dot" />
              <div>
                <span className="trace-time">
                  {new Date(e.createdAt).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {e.detail.round > 0 ? " · 判断 " + e.detail.round : ""}
                </span>
                <p>{e.summary}</p>
                {e.detail.explanation && (
                  <div className="trace-explanation">
                    <Markdown>{e.detail.explanation}</Markdown>
                  </div>
                )}
                {e.type === "reasoning-summary" && (
                  <span className="tag">公开推理摘要</span>
                )}
              </div>
            </article>
          ))}
          {!detail?.events.length && (
            <div className="empty-small">尚未开始讨论。</div>
          )}
        </div>
      ) : (
        <div className="member-messages">
          {detail?.messages
            .filter((m) => m.status === "complete")
            .map((m) => (
              <article key={m.id}>
                <div className="message-kicker">
                  {m.kind === "opinion" ? "独立观点" : "候选判断"} · 上下文 v
                  {m.contextVersion}
                </div>
                <Markdown>{m.content}</Markdown>
              </article>
            ))}
          {!detail?.messages.some((m) => m.status === "complete") && (
            <div className="empty-small">暂无公开回复。</div>
          )}
        </div>
      )}
    </>
  );
}
function App() {
  const [bootstrap, setBootstrap] = useState({
    conversations: [],
    providers: [],
    pets: [],
    discovering: false,
  });
  const [connected, setConnected] = useState(null);
  const [id, setId] = useState(localStorage.getItem("twp-conversation"));
  const [workspace, setWorkspace] = useState(null);
  const [statuses, setStatuses] = useState({});
  const [modal, setModal] = useState(null);
  const [error, setError] = useState(null);
  const [text, setText] = useState("");
  const [view, setView] = useState("discussion");
  const [rounds, setRounds] = useState(4);
  const [codexPets, setCodexPets] = useState([]);
  const [detail, setDetail] = useState(null);
  const selectedId = useRef(id);
  selectedId.current = id;
  const scroller = useRef(null);
  const follow = useRef(true);
  const current = workspace?.conversation;
  const members = workspace?.members ?? [];
  const running = current?.status === "running";
  const closeModal = () => setModal(null);
  const load = useCallback(async (target) => {
    const result = await api("/conversations/" + target);
    if (selectedId.current !== target) return;
    setWorkspace(result);
    setBootstrap((old) => ({
      ...old,
      conversations: old.conversations
        .map((c) => (c.id === target ? result.conversation : c))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }));
  }, []);
  const boot = useCallback(async () => {
    try {
      const data = await api("/bootstrap");
      setBootstrap(data);
      setConnected(true);
      setId((old) =>
        data.conversations.some((c) => c.id === old)
          ? old
          : (data.conversations[0]?.id ?? null),
      );
    } catch {
      setConnected(false);
    }
  }, []);
  useEffect(() => {
    boot();
  }, [boot]);
  useEffect(() => {
    if (!bootstrap.discovering || !connected) return;
    const timer = setInterval(boot, 1500);
    return () => clearInterval(timer);
  }, [bootstrap.discovering, connected, boot]);
  useEffect(() => {
    if (!id || !connected) {
      setWorkspace(null);
      return;
    }
    localStorage.setItem("twp-conversation", id);
    setError(null);
    setStatuses({});
    setText("");
    setView("discussion");
    follow.current = true;
    let disposed = false;
    let scheduled;
    load(id).catch((e) => setError(e.message));
    const stream = new EventSource("/api/conversations/" + id + "/stream");
    stream.onmessage = (event) => {
      if (disposed) return;
      const value = JSON.parse(event.data);
      if (value.type === "member-status")
        setStatuses((old) => ({ ...old, [value.memberId]: value.status }));
      clearTimeout(scheduled);
      scheduled = setTimeout(() => {
        if (!disposed) load(id).catch((e) => setError(e.message));
      }, 50);
    };
    stream.onerror = () => {
      if (!disposed) setError("实时连接正在恢复…");
    };
    stream.onopen = () => {
      if (!disposed) setError(null);
    };
    return () => {
      disposed = true;
      clearTimeout(scheduled);
      stream.close();
    };
  }, [id, connected, load]);
  useEffect(() => {
    if (follow.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [workspace?.messages.length, current?.status]);
  useEffect(() => {
    follow.current = view === "discussion";
    if (view === "context" && scroller.current) scroller.current.scrollTop = 0;
  }, [view]);
  useEffect(() => {
    if (modal?.type !== "trace" || !id) return;
    let disposed = false;
    setDetail(null);
    api("/conversations/" + id + "/members/" + modal.member.id)
      .then((value) => {
        if (!disposed) setDetail(value);
      })
      .catch((e) => setError(e.message));
    return () => {
      disposed = true;
    };
  }, [modal?.type, modal?.member?.id, id, workspace?.events.length]);
  const refreshPets = async () => {
    const result = await api("/pets");
    setCodexPets(result.codex);
    setBootstrap((old) => ({ ...old, pets: result.pets }));
    return result;
  };
  const newConversation = async () => {
    try {
      const { conversation } = await api("/conversations", "POST", {});
      setBootstrap((old) => ({
        ...old,
        conversations: [conversation, ...old.conversations],
      }));
      setId(conversation.id);
      setWorkspace({ conversation, members: [], messages: [], events: [] });
      await refreshPets();
      setModal({ type: "agent" });
    } catch (e) {
      setError(e.message);
    }
  };
  const importPet = async (body) => {
    const { pet } = await api("/pets/import", "POST", body);
    await refreshPets();
    return pet;
  };
  const openAgent = async (member) => {
    try {
      await refreshPets();
      setModal({ type: "agent", member });
    } catch (e) {
      setError(e.message);
    }
  };
  const send = async (e) => {
    e?.preventDefault();
    if (!text.trim() || running || !id) return;
    setError(null);
    follow.current = true;
    try {
      await api("/conversations/" + id + "/discuss", "POST", {
        text,
        maxRounds: rounds,
      });
      setText("");
      await load(id);
      await boot();
    } catch (e) {
      setError(e.message);
    }
  };
  const remove = async (member) => {
    try {
      await api("/conversations/" + id + "/members/" + member.id, "DELETE", {});
      await load(id);
    } catch (e) {
      setError(e.message);
    }
  };
  const petFor = (member) => bootstrap.pets.find((p) => p.id === member.petId);
  const activeProject =
    current?.projectPath?.split("/").filter(Boolean).at(-1) ?? "选择项目";
  const judgments = (workspace?.messages ?? []).filter(
    (m) =>
      m.kind === "judgment" &&
      m.status === "complete" &&
      m.judgment?.candidateId === current?.candidate?.id,
  );
  const latestJudgments = members.map((m) => ({
    member: m,
    vote: judgments.filter((v) => v.author === m.id).at(-1),
  }));
  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="TalkWithPeer">
          <Mark />
          <span>TalkWithPeer</span>
        </a>
        <button
          className="new-chat"
          onClick={newConversation}
          disabled={!connected}
        >
          <Plus size={19} />
          新会话
        </button>
        <div className="sidebar-label">会话</div>
        <nav className="conversation-list">
          {bootstrap.conversations.map((c) => (
            <button
              key={c.id}
              className={"conversation-link " + (c.id === id ? "active" : "")}
              onClick={() => setId(c.id)}
            >
              <ChatCircle size={17} />
              <span>{c.title}</span>
              {c.status === "running" && <i className="running-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            onClick={() => setModal({ type: "settings" })}
            disabled={!connected}
          >
            <GearSix size={18} />
            设置
          </button>
          <span className="local-label">本机工作空间</span>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="conversation-heading">
            <button
              className="title-button"
              title={current?.title}
              onClick={() =>
                current && setModal({ type: "rename", title: current.title })
              }
              disabled={!current}
            >
              {current?.title ?? "TalkWithPeer"}
            </button>
            {current?.status && current.status !== "idle" && (
              <span className={"status-tag " + current.status}>
                {stateLabels[current.status]}
              </span>
            )}
          </div>
          <div className="header-actions">
            <button
              className="project-control"
              disabled={!id || running}
              title={current?.projectPath ?? "选择本地项目"}
              onClick={() => setModal({ type: "project" })}
            >
              <FolderSimple size={17} />
              <span>{activeProject}</span>
              <CaretDown size={12} />
            </button>
            <IconButton
              className="mobile-settings"
              label="设置"
              onClick={() => setModal({ type: "settings" })}
              disabled={!connected}
            >
              <GearSix size={18} />
            </IconButton>
            <Menu.Root>
              <Menu.Trigger asChild>
                <IconButton label="会话选项" disabled={!id}>
                  <DotsThree size={22} />
                </IconButton>
              </Menu.Trigger>
              <Menu.Portal>
                <Menu.Content className="menu-content" sideOffset={6}>
                  <Menu.Item
                    onSelect={() =>
                      setModal({ type: "rename", title: current.title })
                    }
                  >
                    重命名会话
                  </Menu.Item>
                  <Menu.Item
                    onSelect={() =>
                      setView(view === "context" ? "discussion" : "context")
                    }
                  >
                    {view === "context" ? "返回讨论" : "查看共享记录"}
                  </Menu.Item>
                  <Menu.Item
                    disabled={running}
                    onSelect={() => setModal({ type: "members" })}
                  >
                    管理参与者
                  </Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
          </div>
        </header>
        <div className="content-area">
          {connected === false ? (
            <div className="connect-state">
              <Mark />
              <h1>TalkWithPeer</h1>
              <a className="button primary" href="http://127.0.0.1:48273/">
                打开本机工作台
              </a>
              <p>启动本机服务后连接。</p>
            </div>
          ) : connected === null ? (
            <div className="loading-state">
              <div className="skeleton wide-line" />
              <div className="skeleton" />
              <div className="skeleton short-line" />
            </div>
          ) : (
            <>
              <div
                className="thread"
                ref={scroller}
                onScroll={() => {
                  const el = scroller.current;
                  if (el)
                    follow.current =
                      el.scrollHeight - el.scrollTop - el.clientHeight < 140;
                }}
              >
                {!id ? (
                  <div className="empty-conversation">
                    <Mark />
                    <h1>TalkWithPeer</h1>
                    <button
                      className="button secondary"
                      onClick={newConversation}
                    >
                      <Plus size={17} />
                      创建会话
                    </button>
                  </div>
                ) : view === "context" ? (
                  <div className="shared-records">
                    <div className="pane-heading">
                      <h2>共享记录</h2>
                      <button
                        className="text-button"
                        onClick={() => setView("discussion")}
                      >
                        返回讨论
                      </button>
                    </div>
                    <div className="record-meta">
                      <span>上下文 v{current.contextVersion}</span>
                      <span>{members.length} 位参与者</span>
                    </div>
                    <ContextPanel
                      key={id}
                      conversationId={id}
                      members={members}
                      running={running}
                      revision={workspace?.events.length}
                      onChange={() => load(id)}
                    />
                    {current.candidate ? (
                      <>
                        <h3>候选结果 {current.candidate.revision}</h3>
                        <div className="candidate-body">
                          <Markdown>{current.candidate.text}</Markdown>
                        </div>
                        <h3>各方判断</h3>
                        <div className="judgment-list">
                          {latestJudgments.map(({ member, vote }) => (
                            <article key={member.id}>
                              <Pet pet={petFor(member)} size={32} />
                              <div>
                                <strong>{member.name}</strong>
                                <p>{vote?.content ?? "等待本轮判断"}</p>
                              </div>
                              <span
                                className={
                                  "stance " + (vote?.judgment.stance ?? "")
                                }
                              >
                                {stanceName(vote?.judgment) ?? "待判断"}
                              </span>
                            </article>
                          ))}
                        </div>
                      </>
                    ) : (
                      <p className="empty-small">当前没有候选结果。</p>
                    )}
                  </div>
                ) : (
                  <div className="message-list">
                    {!workspace?.messages.length && (
                      <div className="conversation-empty">
                        <h2>{current?.title ?? "新会话"}</h2>
                        {!members.length && (
                          <button
                            className="button secondary"
                            onClick={() => openAgent()}
                          >
                            <Plus size={17} />
                            添加参与者
                          </button>
                        )}
                      </div>
                    )}
                    {(workspace?.messages ?? []).map((message) => {
                      const member = members.find(
                        (m) => m.id === message.author,
                      );
                      if (message.author === "user")
                        return (
                          <article className="user-message" key={message.id}>
                            <div>{message.content}</div>
                          </article>
                        );
                      if (message.kind === "result")
                        return (
                          <article
                            className={"result-message " + message.result.kind}
                            key={message.id}
                          >
                            <div className="result-heading">
                              {message.result.kind === "consensus" ? (
                                <CheckCircle size={20} />
                              ) : (
                                <GitBranch size={20} />
                              )}
                              <strong>
                                {message.result.candidateId !==
                                current?.candidate?.id
                                  ? "先前结论"
                                  : message.result.kind === "consensus"
                                    ? "达成共识"
                                    : "保留分歧"}
                              </strong>
                              <button
                                className="text-button"
                                onClick={() => setView("context")}
                              >
                                查看判断
                              </button>
                            </div>
                            <Markdown>{message.content}</Markdown>
                          </article>
                        );
                      return (
                        <article className="agent-message" key={message.id}>
                          <button
                            className="message-avatar"
                            aria-label={
                              "查看 " +
                              (member?.name ?? message.authorName) +
                              " 的过程"
                            }
                            onClick={() =>
                              member && setModal({ type: "trace", member })
                            }
                          >
                            <Pet
                              pet={member ? petFor(member) : null}
                              size={32}
                            />
                          </button>
                          <div className="message-main">
                            <div className="message-header">
                              <strong>
                                {member?.name ?? message.authorName ?? "Agent"}
                              </strong>
                              <span>
                                {message.kind === "opinion"
                                  ? "独立观点"
                                  : "判断 " + message.round}
                              </span>
                              <time>
                                {new Date(message.createdAt).toLocaleTimeString(
                                  "zh-CN",
                                  { hour: "2-digit", minute: "2-digit" },
                                )}
                              </time>
                            </div>
                            {message.status === "streaming" ? (
                              <div className="thinking-indicator">
                                <i />
                                <i />
                                <i />
                                <span>
                                  {message.kind === "opinion"
                                    ? "正在形成观点"
                                    : "正在审视候选"}
                                </span>
                              </div>
                            ) : (
                              <Markdown
                                components={{
                                  a: (props) => (
                                    <a
                                      {...props}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                    />
                                  ),
                                }}
                              >
                                {message.content}
                              </Markdown>
                            )}
                            {message.error && (
                              <div className="message-failure">
                                {message.error}
                              </div>
                            )}
                            {message.status === "complete" && (
                              <div className="message-footer">
                                <span>{message.model}</span>
                                <span>上下文 v{message.contextVersion}</span>
                                {message.judgment?.stance && (
                                  <span
                                    className={
                                      "stance " + message.judgment.stance
                                    }
                                  >
                                    {stanceName(message.judgment)}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </article>
                      );
                    })}
                    {current?.status === "paused" && (
                      <div className="pause-notice">
                        <p>{current.pauseReason}</p>
                        <button
                          className="button secondary"
                          onClick={async () => {
                            try {
                              await api(
                                "/conversations/" + id + "/continue",
                                "POST",
                                { maxRounds: rounds },
                              );
                              await load(id);
                            } catch (e) {
                              setError(e.message);
                            }
                          }}
                        >
                          继续讨论
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="composer-area">
                <ErrorLine error={error} />
                {id && (
                  <div className="member-strip">
                    {members.map((member) => (
                      <button
                        className="member-chip"
                        key={member.id}
                        disabled={running}
                        onClick={() => openAgent(member)}
                      >
                        <span
                          className={
                            "member-mark " +
                            (bootstrap.providers.find(
                              (p) => p.id === member.providerId,
                            )?.kind ?? "a2a")
                          }
                        />
                        {member.name}
                        <CaretDown size={11} />
                      </button>
                    ))}
                    <button
                      className="add-member"
                      disabled={running || members.length >= 8}
                      onClick={() => openAgent()}
                      aria-label="添加参与者"
                    >
                      <Plus size={17} />
                    </button>
                    <button
                      className="text-button context-button"
                      onClick={() =>
                        setView(view === "context" ? "discussion" : "context")
                      }
                    >
                      {view === "context" ? "讨论" : "共享记录"}
                    </button>
                  </div>
                )}
                {view === "discussion" && (
                  <form className="composer" onSubmit={send}>
                    <textarea
                      aria-label="向参与者提问"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          send();
                        }
                      }}
                      placeholder={
                        !id
                          ? "创建会话后开始讨论"
                          : !members.length
                            ? "添加参与者后开始讨论"
                            : "向参与者提问…"
                      }
                      disabled={!id || !members.length}
                      maxLength={12000}
                      rows={2}
                    />
                    <div className="composer-controls">
                      <label className="round-control">
                        判断轮数
                        <select
                          value={rounds}
                          onChange={(e) => setRounds(Number(e.target.value))}
                          disabled={running}
                          aria-label="本次判断轮数上限"
                        >
                          {[1, 2, 3, 4, 6, 8].map((n) => (
                            <option value={n} key={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </label>
                      {running ? (
                        <button
                          className="send-button stop"
                          type="button"
                          aria-label="暂停讨论"
                          onClick={async () => {
                            try {
                              await api(
                                "/conversations/" + id + "/stop",
                                "POST",
                                {},
                              );
                            } catch (e) {
                              setError(e.message);
                            }
                          }}
                        >
                          <Stop size={18} weight="fill" />
                        </button>
                      ) : (
                        <button
                          className="send-button"
                          type="submit"
                          aria-label="开始讨论"
                          disabled={!id || !members.length || !text.trim()}
                        >
                          <ArrowUp size={20} weight="bold" />
                        </button>
                      )}
                    </div>
                  </form>
                )}
                {view === "context" && running && (
                  <button
                    className="button secondary"
                    onClick={async () => {
                      try {
                        await api("/conversations/" + id + "/stop", "POST", {});
                      } catch (e) {
                        setError(e.message);
                      }
                    }}
                  >
                    暂停讨论
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        {connected && id && (
          <aside className="pet-dock" aria-label="讨论参与者">
            {members.map((member) => {
              const pending = workspace?.messages.find(
                (m) => m.author === member.id && m.status === "streaming",
              );
              const status =
                statuses[member.id] ??
                (pending
                  ? pending.kind === "opinion"
                    ? "thinking"
                    : "reviewing"
                  : current?.status === "paused"
                    ? "paused"
                    : current?.status === "deadlock"
                      ? "deadlock"
                      : "idle");
              return (
                <button
                  className="pet-seat"
                  key={member.id}
                  onClick={() => setModal({ type: "trace", member })}
                  aria-label={"查看 " + member.name + " 的会话与过程"}
                  title={member.name + " · " + member.model}
                >
                  <Pet pet={petFor(member)} status={status} size={64} />
                  <span>{member.name}</span>
                  {["thinking", "reviewing"].includes(status) && <i />}
                </button>
              );
            })}
          </aside>
        )}
      </main>
      {modal && (
        <Modal
          title={
            {
              agent: modal.member ? "编辑参与者" : "添加参与者",
              project: "选择本地项目",
              pets: "Pets",
              connect: "添加连接",
              settings: "设置",
              members: "参与者",
              trace: modal.member?.name,
              rename: "重命名会话",
            }[modal.type]
          }
          onClose={closeModal}
          wide={["trace", "pets", "members"].includes(modal.type)}
        >
          {modal.type === "agent" && (
            <AgentForm
              providers={bootstrap.providers}
              pets={bootstrap.pets}
              codexPets={codexPets}
              member={modal.member}
              onClose={closeModal}
              onPetImport={(source) =>
                importPet({ source: "codex", id: source })
              }
              onSave={async (input) => {
                await api(
                  "/conversations/" +
                    id +
                    "/members" +
                    (modal.member ? "/" + modal.member.id : ""),
                  modal.member ? "PATCH" : "POST",
                  input,
                );
                await load(id);
              }}
            />
          )}
          {modal.type === "project" && (
            <ProjectPicker
              selected={current?.projectPath}
              onClose={closeModal}
              onSave={async (projectPath) => {
                await api("/conversations/" + id, "PATCH", { projectPath });
                await load(id);
              }}
            />
          )}
          {modal.type === "pets" && (
            <PetManager
              pets={bootstrap.pets}
              codexPets={codexPets}
              onImport={importPet}
              onClose={closeModal}
            />
          )}
          {modal.type === "connect" && (
            <ConnectionForm
              onClose={closeModal}
              onSave={async (body) => {
                const { provider } = await api("/providers", "POST", body);
                setBootstrap((old) => ({
                  ...old,
                  providers: [...old.providers, provider],
                }));
              }}
            />
          )}
          {modal.type === "settings" && (
            <>
              <div className="settings-heading">
                <h3>连接</h3>
                <button
                  className="text-button"
                  onClick={async () => {
                    try {
                      const data = await api("/providers/refresh", "POST", {});
                      setBootstrap((old) => ({
                        ...old,
                        providers: data.providers,
                      }));
                    } catch (e) {
                      setError(e.message);
                    }
                  }}
                >
                  <ArrowsClockwise size={15} />
                  刷新能力
                </button>
              </div>
              <div className="connection-list">
                {bootstrap.providers.map((p) => (
                  <div className="connection-row" key={p.id}>
                    <Robot size={21} />
                    <div>
                      <strong>{p.name}</strong>
                      <span>
                        {p.models.length
                          ? (p.kind === "api" ? "模型 API · " : "Agent · ") +
                            p.models.length +
                            " 个模型"
                          : (p.error ?? "需要配置")}
                      </span>
                    </div>
                    <span
                      className={
                        "connection-state " + (p.models.length ? "ready" : "")
                      }
                    >
                      {p.models.length ? "已发现" : "未就绪"}
                    </span>
                  </div>
                ))}
              </div>
              <button
                className="button secondary full-width"
                onClick={() => setModal({ type: "connect" })}
              >
                <Plus size={16} />
                添加 API / Agent 连接
              </button>
              <div className="settings-divider" />
              <div className="settings-heading">
                <h3>Pets</h3>
                <button
                  className="text-button"
                  onClick={async () => {
                    try {
                      await refreshPets();
                      setModal({ type: "pets" });
                    } catch (e) {
                      setError(e.message);
                    }
                  }}
                >
                  管理 pet
                </button>
              </div>
            </>
          )}
          {modal.type === "members" && (
            <div className="connection-list">
              {members.map((member) => (
                <div className="connection-row" key={member.id}>
                  <Pet pet={petFor(member)} size={38} />
                  <div>
                    <strong>{member.name}</strong>
                    <span>{member.model}</span>
                  </div>
                  <IconButton
                    label={"编辑 " + member.name}
                    onClick={() => openAgent(member)}
                  >
                    <SlidersHorizontal size={18} />
                  </IconButton>
                  <IconButton
                    label={"移除 " + member.name}
                    onClick={() => remove(member)}
                  >
                    <X size={17} />
                  </IconButton>
                </div>
              ))}
              <button
                className="button secondary full-width"
                onClick={() => openAgent()}
              >
                <Plus size={16} />
                添加参与者
              </button>
            </div>
          )}
          {modal.type === "trace" && (
            <TraceView
              detail={detail}
              member={modal.member}
              pet={petFor(modal.member)}
            />
          )}
          {modal.type === "rename" && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await api("/conversations/" + id, "PATCH", {
                    title: modal.title,
                  });
                  await load(id);
                  closeModal();
                } catch (e) {
                  setError(e.message);
                }
              }}
            >
              <label className="field">
                会话名称
                <input
                  autoFocus
                  value={modal.title}
                  onChange={(e) =>
                    setModal({ ...modal, title: e.target.value })
                  }
                  maxLength={100}
                  required
                />
              </label>
              <FormButtons label="保存" onClose={closeModal} />
            </form>
          )}
          <ErrorLine error={error} />
        </Modal>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
