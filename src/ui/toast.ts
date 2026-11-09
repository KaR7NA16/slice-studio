// 轻量提示：只用于「结果不落在页面上、稍后自己消失」的动作（归档、复制路径、后台保存失败）。
// 页面内的失败一律用 .msg.err（就地显示，不会消失），别用 toast 掩盖持久错误。
import { icon } from "./icons.ts";

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (host && host.isConnected) return host;
  host = document.createElement("div");
  host.className = "toast-host";
  host.setAttribute("role", "status");
  host.setAttribute("aria-live", "polite");
  document.body.appendChild(host);
  return host;
}

export function toast(text: string, kind: "info" | "err" = "info"): void {
  const h = ensureHost();
  const el = document.createElement("div");
  el.className = `toast${kind === "err" ? " err" : ""}`;
  el.innerHTML = `${icon(kind === "err" ? "warn" : "check", 12)}<span></span>`;
  el.querySelector("span")!.textContent = text;
  h.appendChild(el);
  while (h.children.length > 3) h.firstElementChild?.remove();
  window.setTimeout(() => el.remove(), kind === "err" ? 5200 : 2600);
}
