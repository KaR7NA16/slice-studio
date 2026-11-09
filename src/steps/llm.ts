// LLM 客户端：OpenAI 兼容单通路（/chat/completions 与 /models），无 provider 分支。
// 错误信息纪律：把裸 HTTP 码翻成「下一步该改什么」；报错正文来自提供方，
// 可能回显 Authorization —— 先擦掉 key 再截断，错误信息不该成为泄漏面。
import type { LlmCall } from "../shared/types.ts";

const trimBase = (u: string): string => u.replace(/\/+$/, "");
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const scrub = (s: string, key: string): string => (key ? s.split(key).join("***") : s);

function explain(status: number, body: string, base: string, apiPath: string): string {
  const tail = body ? `：${body.slice(0, 200)}` : "";
  if (status === 401 || status === 403) return `API Key 无效或无权限（HTTP ${status}）${tail}`;
  if (status === 404) return `地址不对（HTTP 404）：${base} 下没有 ${apiPath}，检查是否少了 /v1${tail}`;
  if (status === 429) return `提供方限流（HTTP 429），稍后重试${tail}`;
  if (status >= 500) return `提供方服务端错误（HTTP ${status}）${tail}`;
  return `请求失败（HTTP ${status} ${apiPath}）${tail}`;
}

// 统一的「发请求 + 把网络异常说人话」段，两个端点共用
async function send(
  url: string,
  apiKey: string,
  timeoutMs: number,
  init: RequestInit,
): Promise<{ ok: true; res: Response } | { ok: false; reason: string }> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: true, res };
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      return { ok: false, reason: `连接超时（${timeoutMs / 1000}s）：${new URL(url).origin}` };
    }
    return { ok: false, reason: `无法连接 ${url}：${scrub(e instanceof Error ? e.message : String(e), apiKey)}` };
  }
}

export async function chatJson(llm: LlmCall, system: string, user: string): Promise<string> {
  const base = trimBase(llm.base_url);
  const r = await send(`${base}/chat/completions`, llm.api_key, 180_000, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  });
  if (!r.ok) throw new Error(r.reason);
  if (!r.res.ok) throw new Error(explain(r.res.status, scrub(await r.res.text(), llm.api_key), base, "/chat/completions"));
  const data = (await r.res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM 返回为空");
  return content;
}

// GET {base_url}/models：OpenAI 兼容的模型清单，不消耗 token。
// 返回 ok:false 而不是抛错——「拉不到」是配置问题的诊断信息，不是服务故障，
// 界面该把它显示在表单旁边，而不是当成一次请求失败。
// 顺序原样保留（提供方常按新旧排），只去重。
export async function listModels(
  baseUrl: string,
  apiKey: string,
): Promise<{ ok: true; models: string[] } | { ok: false; reason: string }> {
  const base = trimBase(baseUrl);
  const r = await send(`${base}/models`, apiKey, 15_000, { method: "GET" });
  if (!r.ok) return { ok: false, reason: r.reason };
  const text = scrub(await r.res.text(), apiKey);
  if (!r.res.ok) return { ok: false, reason: explain(r.res.status, text, base, "/models") };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${base}/models 返回的不是 JSON：${text.slice(0, 120)}` };
  }
  const data = (parsed as { data?: unknown } | null)?.data;
  const ids = Array.isArray(data)
    ? data.map((d) => (typeof d === "string" ? d : str((d as { id?: unknown } | null)?.id))).filter(Boolean)
    : [];
  if (ids.length === 0) {
    return { ok: false, reason: `${base}/models 没给出模型清单（data 为空，或不是 OpenAI 兼容格式）` };
  }
  return { ok: true, models: [...new Set(ids)] };
}

// 最短的一次对话：证明地址、密钥、模型名三项一起能用。
// 不走 response_format——有的提供方清单接口是通的，一要求 JSON 就拒，测试不该被这个绊住。
export async function testChat(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<{ ok: true; reply: string } | { ok: false; reason: string }> {
  const base = trimBase(baseUrl);
  const r = await send(`${base}/chat/completions`, apiKey, 20_000, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with the single word pong." }],
      max_tokens: 16,
      temperature: 0,
    }),
  });
  if (!r.ok) return r;
  const text = scrub(await r.res.text(), apiKey);
  if (!r.res.ok) return { ok: false, reason: explain(r.res.status, text, base, "/chat/completions") };
  let content = "";
  try {
    const data = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
    content = data.choices?.[0]?.message?.content ?? "";
  } catch {
    return { ok: false, reason: `${base}/chat/completions 返回的不是 JSON：${text.slice(0, 120)}` };
  }
  if (!content.trim()) return { ok: false, reason: "LLM 返回为空" };
  return { ok: true, reply: scrub(content, apiKey).slice(0, 80) };
}
