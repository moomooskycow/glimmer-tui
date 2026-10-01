import { lineDiff } from "./diff.js";
import type { ResolvedSpec, Theme } from "./types.js";

export function sanitizeHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<\/script/gi, "<\\/script")
    .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?>[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function kicker(label: string): string {
  return `<div class="kicker">${escapeHtml(label)}</div>`;
}

function titleBlock(title: string, prompt?: string): string {
  return `<h1>${escapeHtml(title)}</h1>${prompt ? `<p class="prompt">${escapeHtml(prompt)}</p>` : ""}`;
}

function bodyFor(spec: ResolvedSpec): string {
  switch (spec.type) {
    case "choice":
      return `${kicker("Choose")}
        ${titleBlock(spec.title, spec.prompt)}
        <div class="stack">
          ${spec.options
            .map(
              (option, index) => `<button type="button" class="choice" data-nav data-action="select" data-value="${escapeHtml(option.id)}" data-complete="true">
                <span class="choice-index">${index + 1}</span>
                <span class="choice-copy">
                  <span class="choice-label">${escapeHtml(option.label)}</span>
                  ${option.description ? `<span class="choice-desc">${escapeHtml(option.description)}</span>` : ""}
                </span>
              </button>`,
            )
            .join("")}
        </div>`;
    case "form":
      return `${kicker("Details")}
        ${titleBlock(spec.title, spec.prompt)}
        <form>
          ${spec.fields
            .map((field) => {
              const control = field.multiline
                ? `<textarea name="${escapeHtml(field.name)}" rows="3" placeholder="${escapeHtml(field.placeholder ?? "")}"></textarea>`
                : `<input name="${escapeHtml(field.name)}" type="text" placeholder="${escapeHtml(field.placeholder ?? "")}" />`;
              return `<label class="field"><span>${escapeHtml(field.label)}</span>${control}</label>`;
            })
            .join("")}
          <div class="actions">
            <button type="button" class="primary" data-action="submit" data-complete="true">${escapeHtml(spec.submitLabel ?? "Continue")}</button>
          </div>
        </form>`;
    case "approval":
      return `${kicker("Approval")}
        ${titleBlock(spec.title)}
        <p class="body">${escapeHtml(spec.body)}</p>
        ${spec.detail ? `<pre class="detail">${escapeHtml(spec.detail)}</pre>` : ""}
        <div class="actions">
          <button type="button" class="ghost" data-nav data-action="reject" data-complete="true">${escapeHtml(spec.rejectLabel ?? "Reject")}</button>
          <button type="button" class="primary" data-nav data-action="approve" data-complete="true">${escapeHtml(spec.approveLabel ?? "Approve")}</button>
        </div>`;
    case "table":
      return `${kicker("Table")}
        ${titleBlock(spec.title)}
        <table>
          <thead><tr>${spec.columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr></thead>
          <tbody>
            ${spec.rows
              .map((row, index) => {
                const attrs = spec.selectable
                  ? ` class="clickable" tabindex="0" data-nav data-action="select-row" data-value="${index}" data-complete="true"`
                  : "";
                return `<tr${attrs}>${spec.columns
                  .map((column) => `<td>${escapeHtml(String(row[column.key] ?? ""))}</td>`)
                  .join("")}</tr>`;
              })
              .join("")}
          </tbody>
        </table>`;
    case "chart": {
      const max = Math.max(...spec.series.map((point) => point.value), 1);
      return `${kicker("Chart")}
        ${titleBlock(spec.title)}
        <div class="bars">
          ${spec.series
            .map((point) => {
              const width = Math.max(2, Math.round((point.value / max) * 100));
              return `<div class="bar-row">
                <span class="bar-label">${escapeHtml(point.label)}</span>
                <span class="bar-track"><span class="bar-fill" style="width:${width}%"></span></span>
                <span class="bar-value">${escapeHtml(String(point.value))}${spec.unit ? `<i>${escapeHtml(spec.unit)}</i>` : ""}</span>
              </div>`;
            })
            .join("")}
        </div>`;
    }
    case "diff": {
      const lines = lineDiff(spec.before, spec.after);
      return `${kicker("Diff")}
        ${titleBlock(spec.title)}
        <div class="diff">
          ${lines
            .map((line) => {
              const mark = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
              return `<div class="diff-line ${line.kind}"><span>${mark}</span>${escapeHtml(line.text) || " "}</div>`;
            })
            .join("")}
        </div>`;
    }
    case "html":
      return `${spec.title ? `${kicker("HTML")}${titleBlock(spec.title)}` : ""}<div class="free">${sanitizeHtml(spec.html)}</div>`;
    default:
      return "";
  }
}

const CSS = `
:root {
  color-scheme: light;
  --bg: #efe7dc;
  --card: #fbf7f1;
  --ink: #1d1915;
  --muted: #6f675e;
  --line: #e4d8c8;
  --accent: #0f6f6a;
  --accent-ink: #f3fffd;
  --ghost: transparent;
  --hover: #f3ebe1;
  --add: #e5f6ec;
  --add-ink: #14653a;
  --del: #fbeaea;
  --del-ink: #8d2d2d;
  --shadow: 0 1px 0 rgba(255,255,255,.7) inset;
  --sans: Inter, "Noto Sans", "Segoe UI", sans-serif;
  --serif: "Iowan Old Style", "Noto Serif", Palatino, Georgia, serif;
  --mono: "Noto Sans Mono", "SFMono-Regular", ui-monospace, monospace;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #12161b;
  --card: #191e25;
  --ink: #f4efe7;
  --muted: #b1a79c;
  --line: #2c3440;
  --accent: #8ed9d1;
  --accent-ink: #08211f;
  --hover: #222a34;
  --add: #163226;
  --add-ink: #b7ebc9;
  --del: #3a2022;
  --del-ink: #f3c1c1;
  --shadow: 0 1px 0 rgba(255,255,255,.04) inset;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--ink); }
body { font-family: var(--sans); font-size: 15px; line-height: 1.45; }
.card {
  padding: 18px 18px 16px;
  background: var(--card);
  box-shadow: var(--shadow);
}
.kicker {
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--accent);
  font-weight: 650;
}
h1 {
  font-family: var(--serif);
  font-weight: 560;
  font-size: 28px;
  line-height: 1.15;
  margin: 6px 0 8px;
  letter-spacing: -0.02em;
}
.prompt, .body { margin: 0 0 14px; color: var(--muted); }
.stack { display: flex; flex-direction: column; gap: 8px; }
button, input, textarea { font: inherit; color: inherit; }
.choice, .ghost, .primary, .clickable {
  border-radius: 12px;
  border: 1px solid var(--line);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.choice {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 10px 12px;
  width: 100%;
}
.choice:hover, .choice:focus-visible, .clickable:hover, .clickable:focus-visible, .ghost:hover, .ghost:focus-visible {
  background: var(--hover);
  border-color: var(--accent);
  outline: none;
}
.choice-index {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  font-size: 12px;
  color: var(--accent);
  border: 1px solid var(--line);
  flex: none;
  margin-top: 1px;
}
.choice-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.choice-label { font-weight: 650; }
.choice-desc { color: var(--muted); font-size: 13px; }
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; font-size: 13px; color: var(--muted); }
input, textarea {
  width: 100%;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: transparent;
  padding: 10px 12px;
  color: var(--ink);
}
textarea { resize: none; }
input:focus, textarea:focus { outline: 2px solid var(--accent); border-color: transparent; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.primary, .ghost { padding: 9px 14px; font-weight: 650; }
.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
.primary:hover, .primary:focus-visible { filter: brightness(1.05); outline: none; }
.detail, .diff {
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.45;
  background: color-mix(in srgb, var(--bg) 65%, var(--card));
  border-radius: 10px;
  padding: 10px 12px;
  margin: 0 0 14px;
  overflow: hidden;
}
.diff-line { display: flex; gap: 8px; white-space: pre; }
.diff-line.add { background: var(--add); color: var(--add-ink); }
.diff-line.del { background: var(--del); color: var(--del-ink); }
table { width: 100%; border-collapse: collapse; }
th {
  text-align: left;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 650;
  padding: 0 8px 8px;
}
td { padding: 8px; border-top: 1px solid var(--line); }
.clickable {
  width: 100%;
  display: flex;
  gap: 12px;
  padding: 8px;
  border: 0;
  border-radius: 8px;
}
.bars { display: flex; flex-direction: column; gap: 10px; }
.bar-row { display: grid; grid-template-columns: 92px 1fr auto; gap: 10px; align-items: center; }
.bar-label { font-weight: 650; }
.bar-track { height: 10px; border-radius: 999px; background: var(--line); overflow: hidden; }
.bar-fill { display: block; height: 100%; background: var(--accent); border-radius: inherit; }
.bar-value { font-variant-numeric: tabular-nums; color: var(--muted); }
.bar-value i { font-style: normal; margin-left: 4px; font-size: 12px; }
.free :first-child { margin-top: 0; }
`;

const BRIDGE = `
<script>
window.__glimmer = { events: [], dirty: true };
function glimmerEmit(action, value, complete) {
  window.__glimmer.events.push({ action, value, complete: !!complete });
  window.__glimmer.dirty = true;
}
document.addEventListener("click", (event) => {
  const el = event.target.closest("[data-action]");
  if (!el) return;
  event.preventDefault();
  const action = el.dataset.action;
  const complete = el.dataset.complete === "true";
  if (action === "submit") {
    const form = el.closest("form") || document.querySelector("form");
    const value = form ? Object.fromEntries(new FormData(form).entries()) : {};
    glimmerEmit("submit", value, complete);
    return;
  }
  if (action === "approve") return glimmerEmit("approve", true, complete);
  if (action === "reject") return glimmerEmit("reject", false, complete);
  if (action === "select-row") return glimmerEmit("select-row", Number(el.dataset.value), complete);
  glimmerEmit(action || "click", el.dataset.value ?? null, complete);
});
document.addEventListener("keydown", (event) => {
  const items = [...document.querySelectorAll("[data-nav]")];
  if ((event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "ArrowLeft" || event.key === "ArrowRight") && items.length) {
    const current = items.indexOf(document.activeElement);
    if (current === -1 && event.target && event.target.closest && event.target.closest("input, textarea")) return;
    event.preventDefault();
    const delta = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
    const next = items[(current + delta + items.length) % items.length];
    next.focus();
    return;
  }
  if (event.key === "Enter" && event.target && event.target.matches && event.target.matches("[data-action]")) {
    event.preventDefault();
    event.target.click();
  }
});
const first = document.querySelector("input, textarea, [data-nav]");
if (first) first.focus();
</script>`;

export function renderDocument(spec: ResolvedSpec, theme: Theme): string {
  return `<!doctype html>
<html data-theme="${theme}">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;" />
<style>${CSS}</style>
</head>
<body><main class="card">${bodyFor(spec)}</main>${BRIDGE}</body>
</html>`;
}
