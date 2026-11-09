// 按资源类限流（b44/b45）。槽位在进程内，startRun 拿到槽才起子进程，退出时归还。
// 不同类互不占用：配乐的网络请求不会堵在人声分离后面，反过来也一样。
// demucs 另有自己的常驻进程（权重只加载一次）；cpu 槽只限制同时在跑的步数。
import { stat } from "node:fs/promises";
import path from "node:path";
import { readJson } from "./jsonfile.ts";

export type ResourceClass = "cpu" | "net" | "io";

const DEFAULTS: Record<ResourceClass, number> = { cpu: 2, net: 2, io: 4 };

export function slotLimit(kind: ResourceClass): number {
  const raw = process.env[`SLICE_SLOT_${kind.toUpperCase()}`];
  const n = raw === undefined ? DEFAULTS[kind] : Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULTS[kind];
}

// 分类看的是这一步真正占的资源，不是步骤编号。
// s00 有字幕就是读文件（io）；没有字幕才上本地转写（cpu）。
// s03 的 build 是本地拼接，draft 才打 LLM。
// s04 写了 mood 就走规则（io）；没写才向 LLM 要分组（net）。
export async function resourceOf(root: string, owner: string, step: string, mode: string | null): Promise<ResourceClass> {
  if (step === "s01") return "net";
  if (step === "s02" || step === "s05") return "cpu";
  if (step === "s03") return mode === "draft" ? "net" : "io";
  if (step === "s00") {
    const srt = path.join(root, "work", owner, "source.srt");
    const has = await stat(srt).then((s) => s.isFile()).catch(() => false);
    return has ? "io" : "cpu";
  }
  if (step === "s04") {
    const params = await readJson<{ bgm_mood?: string }>(path.join(root, "work", owner, "s04", "params.json"));
    return params?.bgm_mood ? "io" : "net";
  }
  return "io";
}

const active: Record<ResourceClass, number> = { cpu: 0, net: 0, io: 0 };
const waiters: Record<ResourceClass, Array<() => void>> = { cpu: [], net: [], io: [] };

// 返回的函数归还槽位，可重复调用。后来者在槽满时排队，归还后按到达顺序进入。
export function acquire(kind: ResourceClass): Promise<() => void> {
  const lim = slotLimit(kind);
  return new Promise((resolve) => {
    const enter = (): void => {
      if (active[kind] >= lim) {
        waiters[kind].push(enter);
        return;
      }
      active[kind] += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active[kind] -= 1;
        waiters[kind].shift()?.();
      });
    };
    enter();
  });
}
