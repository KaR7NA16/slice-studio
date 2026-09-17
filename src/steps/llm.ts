// LLM 客户端：OpenAI 兼容 /chat/completions，只此一条通路，无 provider 分支
import type { LlmConfig } from "../server/config.ts";

export async function chatJson(llm: LlmConfig, system: string, user: string): Promise<string> {
  const res = await fetch(`${llm.base_url.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${llm.api_key}`,
    },
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    throw new Error(`LLM 请求失败 ${res.status}：${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM 返回为空");
  return content;
}
