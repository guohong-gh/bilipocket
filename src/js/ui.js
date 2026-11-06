// @ts-check
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function icon(name, className = "") {
  return `<svg class="icon${className ? ` ${className}` : ""}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatSize(mb) {
  const value = Number(mb) || 0;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} GB`;
  if (value > 0 && value < 1) return `${Math.max(1, Math.round(value * 1024))} KB`;
  if (value === 0) return "0 MB";
  return `${value.toFixed(1)} MB`;
}

export function formatSpeed(speed) {
  const value = Number(speed) || 0;
  return value > 0.05 ? `${value.toFixed(1)} MB/s` : "—";
}

export function formatCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.round(count)).toLocaleString("zh-CN") : "0";
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--:--";
  const total = Math.ceil(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

export function formatClock(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function dayKey(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function dayLabel(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  const now = new Date();
  const startOf = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(date)) / 86_400_000);

  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return `${diff} 天前`;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function formatHistoryTime(timestamp) {
  return `${dayLabel(timestamp)} ${formatClock(timestamp)}`;
}

const toastDurations = { info: 3200, success: 3600, error: 4600 };

export function toast(title, options = {}) {
  const region = document.getElementById("toast-region");
  if (!region) return;

  const tone = options.tone || "info";
  const message = options.message || "";
  const action = options.action || null;
  const kind = options.kind || "";
  const duration = options.duration ?? (action ? 5200 : toastDurations[tone] || 3600);
  const iconName = tone === "success" ? "check" : tone === "error" ? "alert" : "info";

  while (region.children.length >= 4) {
    region.firstElementChild?.remove();
  }

  const element = document.createElement("div");
  element.className = `toast toast-${tone}`;
  element.setAttribute("role", tone === "error" ? "alert" : "status");
  if (kind) element.dataset.toastKind = kind;

  element.innerHTML = `
    <span class="toast-icon">${icon(iconName)}</span>
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(title)}</div>
      ${message ? `<div class="toast-message">${escapeHtml(message)}</div>` : ""}
    </div>
    ${action ? `<button class="toast-action" type="button">${escapeHtml(action.label)}</button>` : ""}
    <button class="toast-close" type="button" aria-label="关闭提示">${icon("x")}</button>
  `;

  let timer = null;
  let leaving = false;

  const dismiss = () => {
    if (leaving) return;
    leaving = true;
    clearTimeout(timer);
    element.classList.add("is-leaving");
    window.setTimeout(() => element.remove(), 220);
  };

  const schedule = (ms) => {
    clearTimeout(timer);
    timer = window.setTimeout(dismiss, ms);
  };

  element.querySelector(".toast-close")?.addEventListener("click", dismiss);
  element.querySelector(".toast-action")?.addEventListener("click", () => {
    dismiss();
    action.onClick?.();
  });

  element.addEventListener("mouseenter", () => clearTimeout(timer));
  element.addEventListener("mouseleave", () => schedule(1400));

  region.append(element);
  schedule(duration);
}

export function dismissToastKind(kind) {
  if (!kind) return;
  $$(".toast").forEach((element) => {
    if (element.dataset.toastKind === kind) element.remove();
  });
}

let activeDialog = null;

export function makeFocusTrap(container, onClose) {
  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose(null);
      return;
    }

    if (event.key !== "Tab") return;

    const focusables = Array.from(
      container.querySelectorAll("button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])"),
    ).filter((element) => element.offsetParent !== null);

    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (!container.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  document.addEventListener("keydown", onKeyDown, true);
  return () => document.removeEventListener("keydown", onKeyDown, true);
}

function mountDialog({
  title,
  message,
  target,
  confirmText,
  cancelText,
  tone,
  iconName,
  input,
  checkbox = null,
}) {
  return new Promise((resolve) => {
    activeDialog?.close(null);

    const root = document.getElementById("modal-root");
    const previousFocus = /** @type {HTMLElement | null} */ (document.activeElement);
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const isPrompt = Boolean(input);
    const safeIcon = iconName || (tone === "danger" ? "trash" : "info");

    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-desc">
        <button class="modal-close" type="button" aria-label="关闭对话框">${icon("x")}</button>
        <div class="modal-head">
          <span class="modal-icon${tone === "danger" ? "" : " is-info"}">${icon(safeIcon)}</span>
          <div><h2 id="modal-title">${escapeHtml(title)}</h2></div>
        </div>
        <p id="modal-desc">${escapeHtml(message)}</p>
        ${target ? `<div class="modal-target">${escapeHtml(target)}</div>` : ""}
        ${
          checkbox
            ? `<label class="modal-check">
                 <input id="modal-check" type="checkbox" ${checkbox.checked ? "checked" : ""} aria-describedby="modal-check-desc" />
                 <span><strong>${escapeHtml(checkbox.label || "")}</strong><small id="modal-check-desc">${escapeHtml(checkbox.description || "")}</small></span>
               </label>`
            : ""
        }
        ${
          isPrompt
            ? `<div class="modal-field"><label for="modal-input">${escapeHtml(input.label || "")}</label><input id="modal-input" type="text" spellcheck="false" value="${escapeHtml(input.value || "")}" placeholder="${escapeHtml(input.placeholder || "")}" aria-describedby="modal-input-error" /><p class="modal-field-error" id="modal-input-error" role="alert" hidden>请输入内容后再保存。</p></div>`
            : ""
        }
        <div class="modal-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-modal-cancel>${escapeHtml(cancelText)}</button>
          <button class="btn ${tone === "danger" ? "btn-danger-solid" : "btn-primary"} btn-sm" type="button" data-modal-confirm>${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;

    const modal = /** @type {HTMLElement} */ (backdrop.querySelector(".modal"));
    const inputElement = /** @type {HTMLInputElement | null} */ (modal.querySelector("#modal-input"));
    const inputError = /** @type {HTMLElement | null} */ (modal.querySelector("#modal-input-error"));
    const checkboxElement = /** @type {HTMLInputElement | null} */ (modal.querySelector("#modal-check"));
    const confirmButton = /** @type {HTMLButtonElement | null} */ (modal.querySelector("[data-modal-confirm]"));
    const cancelButton = /** @type {HTMLButtonElement | null} */ (modal.querySelector("[data-modal-cancel]"));
    let settled = false;
    let removeTrap = null;

    const close = (value) => {
      if (settled) return;
      settled = true;
      removeTrap?.();
      root.replaceChildren();
      if (activeDialog?.close === close) activeDialog = null;
      previousFocus?.focus?.();
      resolve(value);
    };

    activeDialog = { close };
    root.replaceChildren(backdrop);
    removeTrap = makeFocusTrap(modal, close);

    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) close(null);
    });

    modal.querySelector(".modal-close")?.addEventListener("click", () => close(null));
    modal.querySelector("[data-modal-cancel]")?.addEventListener("click", () => close(null));

    const confirm = () => {
      if (inputElement) {
        const value = inputElement.value.trim();
        if (!value) {
          inputElement.focus();
          inputElement.setAttribute("aria-invalid", "true");
          if (inputError) inputError.hidden = false;
          modal.querySelector(".modal-field input")?.classList.add("shake");
          window.setTimeout(() => inputElement.classList.remove("shake"), 360);
          return;
        }
        close(value);
        return;
      }
      if (checkboxElement) {
        close({ confirmed: true, checked: checkboxElement.checked });
        return;
      }
      close(true);
    };

    confirmButton?.addEventListener("click", confirm);
    inputElement?.addEventListener("input", () => {
      if (inputElement.getAttribute("aria-invalid") !== "true") return;
      inputElement.removeAttribute("aria-invalid");
      if (inputError) inputError.hidden = true;
    });
    inputElement?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        confirm();
      }
    });

    window.requestAnimationFrame(() => {
      const focusTarget = inputElement || (tone === "danger" ? cancelButton : confirmButton);
      focusTarget?.focus();
      if (inputElement) inputElement.select();
    });
  });
}

export function confirmModal({
  title,
  message,
  target = "",
  confirmText = "确认",
  cancelText = "取消",
  tone = "danger",
  iconName = null,
}) {
  return mountDialog({ title, message, target, confirmText, cancelText, tone, iconName, input: null });
}

export function confirmOptionModal({
  title,
  message,
  target = "",
  confirmText = "确认",
  cancelText = "取消",
  tone = "danger",
  iconName = null,
  checkbox,
}) {
  return mountDialog({
    title,
    message,
    target,
    confirmText,
    cancelText,
    tone,
    iconName,
    input: null,
    checkbox,
  });
}

export function promptModal({ title, message, label = "", value = "", placeholder = "", confirmText = "保存", cancelText = "取消" }) {
  return mountDialog({
    title,
    message,
    target: "",
    confirmText,
    cancelText,
    tone: "info",
    iconName: "folder",
    input: { label, value, placeholder },
  });
}
