// 统一模态：重跑确认 / 改名 / 删除 / 选择文件都走这里。
//
// 为什么不用 window.confirm / prompt：① 原生弹窗是系统样式，暗色主题下会亮起一块白，
// 和已有的 .modal 断裂；② 原生弹窗关掉后焦点不归还，键盘用户会落回 body，得重新 Tab 一圈。
// 这里两件事都做了：Esc / 点遮罩可关，关闭时焦点回到触发它的那个元素。
import { icon } from "./icons.ts";

let seq = 0;
let openCount = 0;

export interface Shell {
  root: HTMLElement;
  card: HTMLElement;
  close: () => void;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
}

// 只负责外壳与键盘纪律；内容由调用方给（picker 要自己维护列表，所以拆出这一层）
export function mountShell(opts: {
  title: string;
  bodyHtml: string;
  footHtml: string;
  className?: string;
  onClose?: () => void;
}): Shell {
  const prev = (document.activeElement as HTMLElement | null) ?? null;
  const id = `modal-title-${++seq}`;
  const host = document.createElement("div");
  host.className = `modal${opts.className ? ` ${opts.className}` : ""}`;
  host.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="${id}">
      <div class="modal-head" id="${id}">${opts.title}</div>
      <div class="modal-body">${opts.bodyHtml}</div>
      <div class="modal-foot">${opts.footHtml}</div>
    </div>`;
  document.body.appendChild(host);
  openCount++;
  document.body.style.overflow = "hidden";

  const card = host.querySelector(".modal-card") as HTMLElement;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    opts.onClose?.();
    host.remove();
    openCount = Math.max(0, openCount - 1);
    if (openCount === 0) document.body.style.overflow = "";
    // 焦点归还：触发元素可能已被重画替换（列表重渲染），那就落到 body
    if (prev && prev.isConnected) prev.focus();
  };

  host.addEventListener("mousedown", (e) => {
    if (e.target === host) close();
  });
  host.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const list = focusables(card);
    if (list.length === 0) return;
    const first = list[0]!;
    const last = list[list.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  window.setTimeout(() => {
    const el = card.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(card)[0];
    el?.focus();
  }, 0);

  return { root: host, card, close };
}

export interface ModalAction {
  label: string;
  value: string;
  kind?: "primary" | "danger" | "ghost";
  autofocus?: boolean;
}

export function openModal(opts: {
  title: string;
  bodyHtml: string;
  actions: ModalAction[];
  className?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const foot = opts.actions
      .map((a) => {
        const cls = a.kind === "primary" ? "btn primary" : a.kind === "danger" ? "btn danger" : "btn";
        return `<button class="${cls}" type="button" data-act="${a.value}"${a.autofocus ? " data-autofocus" : ""}>${a.label}</button>`;
      })
      .join("");
    const shell = mountShell({
      title: opts.title,
      bodyHtml: opts.bodyHtml,
      footHtml: foot,
      className: opts.className,
      onClose: () => finish(null),
    });
    for (const b of Array.from(shell.root.querySelectorAll<HTMLButtonElement>("[data-act]"))) {
      b.addEventListener("click", () => {
        const v = b.dataset.act ?? null;
        // 先落值再关：close 会同步触发 onClose(null)，settled 保证先到的值生效
        finish(v);
        shell.close();
      });
    }
  });
}

export async function confirmModal(opts: {
  title: string;
  bodyHtml: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  const v = await openModal({
    title: opts.title,
    bodyHtml: opts.bodyHtml,
    actions: [
      { label: opts.cancelLabel ?? "取消", value: "cancel" },
      { label: opts.confirmLabel ?? "确认", value: "ok", kind: opts.danger ? "danger" : "primary", autofocus: true },
    ],
  });
  return v === "ok";
}

export function promptModal(opts: {
  title: string;
  label: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const shell = mountShell({
      title: opts.title,
      bodyHtml: `<label class="hint block" for="prompt-input">${opts.label}</label>
        <input class="text" id="prompt-input" value="${escapeAttr(opts.value ?? "")}" placeholder="${escapeAttr(opts.placeholder ?? "")}" data-autofocus />`,
      footHtml: `<button class="btn" type="button" data-act="cancel">取消</button>
        <button class="btn primary" type="button" data-act="ok">${opts.confirmLabel ?? "保存"}</button>`,
      onClose: () => finish(null),
    });
    const input = shell.root.querySelector<HTMLInputElement>("#prompt-input")!;
    const ok = (): void => {
      // 先取值再关：关掉之后输入框已经脱离 DOM
      const v = input.value.trim();
      finish(v);
      shell.close();
    };
    shell.root.querySelector('[data-act="ok"]')!.addEventListener("click", ok);
    shell.root.querySelector('[data-act="cancel"]')!.addEventListener("click", () => shell.close());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        ok();
      }
    });
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

// 危险操作的正文：把「会发生什么」写清楚，而不是只问一句「确定吗」
export function dangerBody(lines: string[]): string {
  return `<div class="warn-box">${lines.map((l) => `<div>${icon("warn", 12)}${l}</div>`).join("")}</div>`;
}
