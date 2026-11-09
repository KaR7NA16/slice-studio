// LLM 的三个写入口：保存配置、拉模型清单、测试连通。
// 密钥不出进程：响应里只有诊断文案，明文 key 只用来向上游发请求。
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LlmProfile, LlmSave } from "../shared/types.ts";
import { listModels, testChat } from "../steps/llm.ts";
import { readLlm, saveLlm } from "./config.ts";

function sendJson(res: ServerResponse, data: unknown, code = 200): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const sendErr = (res: ServerResponse, code: number, message: string): void => sendJson(res, { error: message }, code);

async function readBody<T>(req: IncomingMessage): Promise<T> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}") as T;
}

type ProbeBody = { profile_id?: string; base_url?: string; api_key?: string; model?: string };

async function savedProfile(root: string, body: ProbeBody): Promise<LlmProfile | undefined> {
  const cfg = await readLlm(root);
  return cfg.profiles.find((p) => p.id === body.profile_id) ?? cfg.profiles.find((p) => p.id === cfg.default_id);
}

// 表单里的值优先（还没保存也能试）。空串回落已存档，和拉模型列表同一条规则。
async function resolveProbe(root: string, body: ProbeBody): Promise<{ base_url: string; api_key: string; model: string }> {
  const saved = await savedProfile(root, body);
  return {
    base_url: (body.base_url ?? "").trim() || saved?.base_url || "",
    api_key: (body.api_key ?? "").trim() || saved?.api_key || "",
    model: (body.model ?? "").trim() || saved?.model || "",
  };
}

function rejectBase(base: string): string | null {
  if (!base) return "还没填 API 地址";
  if (!/^https?:\/\//i.test(base)) return "地址必须以 http:// 或 https:// 开头";
  return null;
}

export async function putLlm(root: string, res: ServerResponse, req: IncomingMessage): Promise<void> {
  const r = await saveLlm(root, await readBody<LlmSave>(req));
  return r.ok ? sendJson(res, r.view) : sendErr(res, 400, r.reason);
}

export async function llmModels(root: string, res: ServerResponse, req: IncomingMessage): Promise<void> {
  const probe = await resolveProbe(root, await readBody<ProbeBody>(req));
  const bad = rejectBase(probe.base_url);
  if (bad) return sendJson(res, { ok: false, reason: bad });
  return sendJson(res, await listModels(probe.base_url, probe.api_key));
}

// 发一条最短的对话，证明地址、密钥、模型名这三项真能用。
// 拉模型清单证明不了模型名写对了。失败也回 200：和拉清单一样，这是配置诊断，不是服务故障。
export async function llmTest(root: string, res: ServerResponse, req: IncomingMessage): Promise<void> {
  const probe = await resolveProbe(root, await readBody<ProbeBody>(req));
  const bad = rejectBase(probe.base_url);
  if (bad) return sendJson(res, { ok: false, reason: bad });
  if (!probe.model) return sendJson(res, { ok: false, reason: "还没填模型" });
  return sendJson(res, await testChat(probe.base_url, probe.api_key, probe.model));
}
