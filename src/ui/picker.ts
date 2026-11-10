// 文件 / 目录选择器（b1 入口）。浏览器拿不到真实路径，所以列表来自服务端（GET /api/fs/list），
// 选中只回传一个路径字符串——不复制文件。
//
// 三种模式共用同一份实现：video（视频）、srt（字幕）、dir（素材目录）。
// 键盘：↑↓ 移动、Enter 进入/选定、Backspace 上一级、Esc 关闭。
import { icon } from "./icons.ts";
import { fmtBytes } from "./lib.ts";
import { mountShell } from "./modal.ts";

export type PickMode = "video" | "srt" | "dir";

interface BrowseEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number | null;
}
interface BrowseResult {
  path: string | null;
  parent: string | null;
  entries: BrowseEntry[];
  truncated: boolean;
  roots: boolean;
}

export interface PickOptions {
  mode: PickMode;
  title: string;
  initial?: string;
  selectLabel?: string;
}

const memKey = (mode: PickMode): string => `ss-pick:${mode}`;

function readMem(mode: PickMode): string | null {
  try {
    return localStorage.getItem(memKey(mode));
  } catch {
    return null;
  }
}
function writeMem(mode: PickMode, dir: string): void {
  try {
    localStorage.setItem(memKey(mode), dir);
  } catch {
    /* 存不了不影响本次选择 */
  }
}

const dirOf = (p: string): string => p.replace(/[\\/][^\\/]*$/, "") || p;

export function pickPath(opts: PickOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    let cur: BrowseResult | null = null;
    let query = "";
    let selected: BrowseEntry | null = null;
    let idx = -1;
    let shown: BrowseEntry[] = [];
    let loadSeq = 0;

    const shell = mountShell({
      title: opts.title,
      className: "picker",
      bodyHtml: `
        <div class="picker-crumbs">
          <button class="minibtn" type="button" data-up>${icon("back", 11)} 上一级</button>
          <span class="path" id="pk-path">…</span>
        </div>
        <div class="picker-search"><input class="text" id="pk-q" type="search" placeholder="${opts.mode === "video" ? "筛选…（只列 mp4 / mov / mkv / webm / avi）" : opts.mode === "srt" ? "筛选…（只列 srt / ass / vtt）" : "筛选子目录…"}" autocomplete="off" /></div>
        <div class="picker-list" id="pk-list" role="listbox" aria-label="文件列表"></div>`,
      footHtml: `<button class="btn" type="button" data-cancel>取消</button>
        <span class="spacer"></span>
        <span class="msg" id="pk-msg" role="status" aria-live="polite"></span>
        <button class="btn primary" type="button" data-ok disabled>${opts.selectLabel ?? "选择"}</button>`,
      onClose: () => finish(null),
    });

    const listEl = shell.root.querySelector<HTMLElement>("#pk-list")!;
    const pathEl = shell.root.querySelector<HTMLElement>("#pk-path")!;
    const msgEl = shell.root.querySelector<HTMLElement>("#pk-msg")!;
    const okBtn = shell.root.querySelector<HTMLButtonElement>("[data-ok]")!;
    const upBtn = shell.root.querySelector<HTMLButtonElement>("[data-up]")!;
    const qEl = shell.root.querySelector<HTMLInputElement>("#pk-q")!;

    const say = (text: string, kind: "info" | "err" = "info"): void => {
      msgEl.className = `msg${kind === "err" ? " err" : ""}`;
      msgEl.textContent = text;
    };

    const paint = (): void => {
      pathEl.textContent = cur?.path ?? "（选择驱动器 / 主目录）";
      pathEl.title = cur?.path ?? "";
      upBtn.disabled = !cur?.parent;
      const q = query.trim().toLowerCase();
      shown = (cur?.entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q));
      if (shown.length === 0) {
        listEl.innerHTML = `<div class="empty-hint">${cur ? (q ? "没有匹配的项" : opts.mode === "dir" ? "这个目录下没有子目录" : "这个目录下没有可选的文件") : "没有可用的入口"}</div>`;
      } else {
        listEl.innerHTML = shown
          .map((e, i) => `<button class="picker-row${e.is_dir ? " is-dir" : ""}" type="button" role="option"
              data-i="${i}" aria-selected="${e === selected}">
              ${icon(e.is_dir ? "folder" : "file", 13)}
              <span class="name">${escapeHtml(e.name)}</span>
              <span class="meta">${e.is_dir ? "目录" : e.size !== null ? fmtBytes(e.size) : ""}</span>
            </button>`)
          .join("");
        if (cur?.truncated) {
          listEl.insertAdjacentHTML("beforeend", `<div class="empty-hint">只显示前 ${shown.length} 项——切到更具体的子目录</div>`);
        }
      }
      idx = selected ? shown.indexOf(selected) : -1;
      for (const row of Array.from(listEl.querySelectorAll<HTMLButtonElement>(".picker-row"))) {
        row.addEventListener("click", () => {
          const i = Number(row.dataset.i);
          const e = shown[i];
          if (!e) return;
          if (e.is_dir) {
            void load(e.path);
            return;
          }
          selected = e;
          idx = i;
          paint();
          okBtn.disabled = false;
          (listEl.querySelector(`.picker-row[data-i="${i}"]`) as HTMLElement | null)?.focus();
        });
        row.addEventListener("dblclick", () => {
          const e = shown[Number(row.dataset.i)];
          if (e && !e.is_dir) confirmPick();
        });
        row.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            const e = shown[Number(row.dataset.i)];
            if (!e) return;
            if (e.is_dir) void load(e.path);
            else {
              selected = e;
              confirmPick();
            }
          }
        });
      }
      okBtn.disabled = opts.mode === "dir" ? !cur?.path : !selected;
      okBtn.textContent = opts.mode === "dir" ? (opts.selectLabel ?? "用这个目录") : (opts.selectLabel ?? "选择");
    };

    const load = async (target: string | null): Promise<void> => {
      const seq = ++loadSeq;
      say("读取中…");
      try {
        const qs = new URLSearchParams({ mode: opts.mode });
        if (target) qs.set("path", target);
        const r = await fetch(`/api/fs/list?${qs}`);
        const j = (await r.json()) as BrowseResult & { error?: string };
        if (seq !== loadSeq) return;
        if (!r.ok) throw new Error(j.error ?? `${r.status}`);
        cur = j;
        selected = null;
        query = "";
        qEl.value = "";
        say("");
        if (j.path) writeMem(opts.mode, j.path);
        paint();
        // 焦点落到列表第一项：键盘用户不必先 Tab 过搜索框
        listEl.querySelector<HTMLElement>(".picker-row")?.focus();
      } catch (e) {
        if (seq !== loadSeq) return;
        say(e instanceof Error ? e.message : String(e), "err");
      }
    };

    const confirmPick = (): void => {
      const v = opts.mode === "dir" ? cur?.path ?? null : selected?.path ?? null;
      if (!v) return;
      finish(v);
      shell.close();
    };

    upBtn.addEventListener("click", () => {
      if (cur?.parent) void load(cur.parent);
      else void load(null);
    });
    shell.root.querySelector("[data-cancel]")!.addEventListener("click", () => shell.close());
    okBtn.addEventListener("click", confirmPick);
    qEl.addEventListener("input", () => {
      query = qEl.value;
      paint();
    });
    shell.root.addEventListener("keydown", (e) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key === "Backspace" && tag !== "INPUT") {
        e.preventDefault();
        if (cur?.parent) void load(cur.parent);
        else void load(null);
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      if (shown.length === 0) return;
      const next = e.key === "ArrowDown" ? Math.min(shown.length - 1, idx + 1) : Math.max(0, idx - 1);
      const row = listEl.querySelector<HTMLElement>(`.picker-row[data-i="${next}"]`);
      row?.focus();
      idx = next;
    });

    const initial = opts.initial?.trim();
    void load(initial && initial.length > 0 ? (opts.mode === "dir" ? initial : dirOf(initial)) : readMem(opts.mode));
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
