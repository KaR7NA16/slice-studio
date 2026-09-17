// 应用配置（config.json，gitignored；模板 config.example.json）
// 设计：协议层打通——单个 llm 块走 OpenAI 兼容协议，任何提供方改三个字段即可；
// 不做 provider 注册表（不为假想的「多配置切换」造结构）。
import path from "node:path";
import { readJson } from "./jsonfile.ts";

export interface LlmConfig {
  base_url: string;
  api_key: string;
  model: string;
}

export interface AppConfig {
  llm?: Partial<LlmConfig>;
}

export async function loadConfig(root: string): Promise<AppConfig> {
  return (await readJson<AppConfig>(path.join(root, "config.json"))) ?? {};
}

export type LlmStatus = { ok: true; llm: LlmConfig } | { ok: false; reason: string };

export async function llmStatus(root: string): Promise<LlmStatus> {
  const { llm } = await loadConfig(root);
  if (!llm) {
    return { ok: false, reason: "未配置 LLM：编辑 config.json（模板见 config.example.json）" };
  }
  if (!llm.base_url || !llm.api_key || !llm.model) {
    return { ok: false, reason: "config.json 的 llm 块需齐 base_url / api_key / model 三项" };
  }
  return { ok: true, llm: { base_url: llm.base_url, api_key: llm.api_key, model: llm.model } };
}
