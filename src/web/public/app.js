const authToken = new URLSearchParams(window.location.search).get("token") || "";
const apiUrl = (path) => authToken ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(authToken)}` : path;

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_ATTACHMENTS = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024;

const state = {
  connected: false,
  running: false,
  messages: [],
  timeline: [],
  approvals: [],
  clarifications: [],
  todos: [],
  slashCommands: [],
  selectedSuggestion: 0,
  status: {},
  recentEvents: [],
  recentSessions: [],
  sessionId: "",
  attachments: [],
};

const el = {
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  activeTask: document.getElementById("activeTask"),
  modelLabel: document.getElementById("modelLabel"),
  modelInlineLabel: document.getElementById("modelInlineLabel"),
  workspaceLabel: document.getElementById("workspaceLabel"),
  mcpLabel: document.getElementById("mcpLabel"),
  connection: document.getElementById("connection"),
  messages: document.getElementById("messages"),
  composer: document.getElementById("composer"),
  messageInput: document.getElementById("messageInput"),
  sendBtn: document.getElementById("sendBtn"),
  attachBtn: document.getElementById("attachBtn"),
  imageInput: document.getElementById("imageInput"),
  attachmentTray: document.getElementById("attachmentTray"),
  slashSuggestions: document.getElementById("slashSuggestions"),
  slashHelpBtn: document.getElementById("slashHelpBtn"),
  abortBtn: document.getElementById("abortBtn"),
  planOnly: document.getElementById("planOnly"),
  autoApprove: document.getElementById("autoApprove"),
  detailMode: document.getElementById("detailMode"),
  approvalList: document.getElementById("approvalList"),
  sessionIdLabel: document.getElementById("sessionIdLabel"),
  recentSessions: document.getElementById("recentSessions"),
  todoList: document.getElementById("todoList"),
  eventStrip: document.getElementById("eventStrip"),
  sessionDiffBtn: document.getElementById("sessionDiffBtn"),
  diffOverlay: document.getElementById("diffOverlay"),
  diffBody: document.getElementById("diffBody"),
  diffMeta: document.getElementById("diffMeta"),
  refreshDiffBtn: document.getElementById("refreshDiffBtn"),
  closeDiffBtn: document.getElementById("closeDiffBtn"),
  mobileMenuBtn: document.getElementById("mobileMenuBtn"),
  mobileMoreBtn: document.getElementById("mobileMoreBtn"),
  mobileNewBtn: document.getElementById("mobileNewBtn"),
  mobileAbortBtn: document.getElementById("mobileAbortBtn"),
  mobileCloseMenuBtn: document.getElementById("mobileCloseMenuBtn"),
  sidebarBackdrop: document.getElementById("sidebarBackdrop"),
  mobileApprovalPanel: document.getElementById("mobileApprovalPanel"),
  mobileApprovalList: document.getElementById("mobileApprovalList"),
  contextUsage: document.getElementById("contextUsage"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function timeLabel(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function shortPath(path) {
  const text = String(path || "-");
  if (text.length <= 34) return text;
  return `...${text.slice(-31)}`;
}

function renderMarkdownLite(text) {
  const safe = escapeHtml(text);
  return safe
    .replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_m, language, code) => {
      const lang = String(language || "").trim();
      const classAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      return `<pre><code${classAttr}>${code.replace(/^\n|\n$/g, "")}</code></pre>`;
    })
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function compactNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "0";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(num >= 10_000_000 ? 0 : 1)}m`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(num >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(num));
}

function renderContextUsage(usage = {}) {
  if (!el.contextUsage) return;
  const ctx = usage && typeof usage === "object" ? usage : {};
  const used = Number(ctx.used || 0);
  const limit = Number(ctx.limit || 0);
  const percent = limit > 0 ? Math.min(999, Math.round((used / limit) * 100)) : Number(ctx.percent || 0);
  const last = ctx.last && typeof ctx.last === "object" ? ctx.last : null;
  const lastTotal = Number(last?.total_tokens || 0);
  const tokenText = lastTotal > 0 ? ` · last ${compactNumber(last?.input_tokens)}↑ ${compactNumber(last?.output_tokens)}↓` : "";
  el.contextUsage.textContent = limit > 0
    ? `ctx ${compactNumber(used)}/${compactNumber(limit)} (${percent}%)${tokenText}`
    : `ctx ${compactNumber(used)}${tokenText}`;
}

function renderStatus(snapshot = {}) {
  state.status = { ...state.status, ...(snapshot || {}) };
  snapshot = state.status;
  state.running = Boolean(snapshot.running);
  el.statusDot.className = `dot ${snapshot.lastError ? "error" : state.running ? "running" : "idle"}`;
  el.statusText.textContent = snapshot.lastError ? "Error" : state.running ? "Running" : "Idle";
  el.activeTask.textContent = snapshot.activeTask || (state.connected ? "Ready" : "Connecting...");
  const modelText = snapshot.providerLabel || snapshot.model || "-";
  if (el.modelLabel) el.modelLabel.textContent = modelText;
  if (el.modelInlineLabel) el.modelInlineLabel.textContent = `Model: ${modelText}`;
  if (el.workspaceLabel) el.workspaceLabel.textContent = shortPath(snapshot.workspaceDir);
  if (el.mcpLabel) el.mcpLabel.textContent = Array.isArray(snapshot.mcpServers) && snapshot.mcpServers.length ? snapshot.mcpServers.join(", ") : "none";
  if (el.autoApprove) el.autoApprove.checked = Boolean(snapshot.autoApprove);
  if (el.planOnly) el.planOnly.checked = Boolean(snapshot.planOnly);
  if (el.detailMode) el.detailMode.checked = Boolean(snapshot.detailMode);
  if (el.abortBtn) el.abortBtn.disabled = !state.running;
  if (el.mobileAbortBtn) el.mobileAbortBtn.hidden = !state.running;
  if (el.sendBtn) el.sendBtn.disabled = state.running;
  renderContextUsage(snapshot.contextUsage);
}

function toolTitle(item) {
  const tool = String(item.tool || "tool");
  if (tool === "edit_file") return "Edit file";
  if (tool === "write_file") return "Write file";
  if (tool === "replace_in_files") return "Replace in files";
  if (tool === "run_tests") return "Run tests";
  if (tool === "shell") return "Shell";
  if (tool === "rg" || tool === "grep" || tool === "search_files") return "Search";
  return tool;
}

function toolSubject(item) {
  const input = item.input || {};
  if (input.path) return input.path;
  if (input.command) return input.command;
  if (input.query || input.regex || input.pattern) return input.query || input.regex || input.pattern;
  return "";
}

function summarizeToolInput(item) {
  const input = item.input && typeof item.input === "object" ? item.input : {};
  const subject = toolSubject(item);
  if (subject) return subject;
  const keys = Object.keys(input).filter((key) => input[key] != null && input[key] !== "");
  if (!keys.length) return "No input";
  return keys.slice(0, 3).map((key) => `${key}: ${String(input[key]).replace(/\s+/g, " ").slice(0, 80)}`).join(" · ");
}

function renderJsonBlock(label, value) {
  if (value == null || value === "") return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return `<div class="tool-section"><div class="tool-section-title">${escapeHtml(label)}</div><pre><code>${escapeHtml(text)}</code></pre></div>`;
}

function attachmentSrc(item) {
  return item?.data && item?.mimeType ? `data:${item.mimeType};base64,${item.data}` : "";
}

function renderAttachments(attachments = []) {
  const images = (Array.isArray(attachments) ? attachments : []).filter((item) => item?.type === "image");
  if (!images.length) return "";
  return `<div class="message-attachments">${images.map((item) => {
    const name = escapeHtml(item.name || "image");
    const kb = Math.max(1, Math.round(Number(item.bytes || 0) / 1024));
    const src = attachmentSrc(item);
    if (!src) return `<div class="attachment-meta">${name} · ${escapeHtml(item.mimeType || "image")} · ${kb}KB</div>`;
    return `<a class="message-attachment" href="${escapeHtml(src)}" target="_blank" rel="noreferrer" title="${name}">
      <img src="${escapeHtml(src)}" alt="${name}" loading="lazy" />
      <span>${name} · ${kb}KB</span>
    </a>`;
  }).join("")}</div>`;
}

function renderToolResult(result = {}) {
  if (!result || !result.expandable) {
    return result?.preview ? `<div class="tool-preview">${escapeHtml(result.preview)}</div>` : "";
  }
  if (result.kind === "file_edit") {
    return `<details class="tool-details">
      <summary>${escapeHtml(result.diffStat || "View file diff")}</summary>
      ${result.message ? `<div class="tool-preview">${escapeHtml(result.message)}</div>` : ""}
      <pre class="diff"><code>${escapeHtml(result.diff || "")}</code></pre>
    </details>`;
  }
  if (result.kind === "bulk_replace") {
    const files = (result.files || []).map((file) => `<li>${escapeHtml(file.path || "")} <span>${Number(file.replacements || 0)} replacement(s)</span></li>`).join("");
    return `<details class="tool-details">
      <summary>${escapeHtml(result.preview || "View changed files")}</summary>
      <ul class="changed-files">${files}</ul>
    </details>`;
  }
  return `<details class="tool-details"><summary>View result</summary><pre><code>${escapeHtml(result.preview || "")}</code></pre></details>`;
}

function renderTimelineItem(item) {
  if (item.type === "message") {
    const role = String(item.role || "event");
    const label = role === "assistant" ? "PieCode" : role === "user" ? "You" : role;
    return `<article class="message ${escapeHtml(role)}" data-id="${escapeHtml(item.id)}">
      <div class="msg-head"><strong>${escapeHtml(label)}</strong><span>${timeLabel(item.at)}</span></div>
      <div class="msg-content">${renderMarkdownLite(item.content || "")}</div>
      ${renderAttachments(item.attachments)}
    </article>`;
  }
  if (item.type === "progress") {
    const title = item.title || (item.kind === "model" ? "Model" : "Progress");
    const steps = Array.isArray(item.steps) && item.steps.length
      ? `<ol>${item.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>`
      : "";
    return `<div class="progress-card ${escapeHtml(item.kind || "info")}" data-id="${escapeHtml(item.id)}">
      <div class="progress-head"><span>${escapeHtml(title)}</span><time>${timeLabel(item.at)}</time></div>
      ${item.content ? `<div class="progress-content">${escapeHtml(item.content)}</div>` : ""}
      ${steps}
    </div>`;
  }
  if (item.type === "tool") {
    const status = String(item.status || "queued");
    const summary = summarizeToolInput(item);
    const icon = status === "done" ? "✓" : status === "error" ? "!" : "↯";
    const openAttr = state.status.detailMode ? " open" : "";
    return `<details class="tool-card ${escapeHtml(status)}" data-id="${escapeHtml(item.id)}"${openAttr}>
      <summary class="tool-summary">
        <span class="tool-icon">${icon}</span>
        <span class="tool-main">
          <strong>${escapeHtml(toolTitle(item))}</strong>
          <code>${escapeHtml(summary)}</code>
        </span>
        <span class="tool-status">${escapeHtml(status)}</span>
      </summary>
      <div class="tool-body">
        ${item.reason ? `<div class="tool-reason">${escapeHtml(item.reason)}</div>` : ""}
        ${renderJsonBlock("Input", item.input || {})}
        ${item.error ? `<div class="tool-error">${escapeHtml(item.error)}</div>` : ""}
        ${renderToolResult(item.result)}
      </div>
    </details>`;
  }
  return "";
}

function renderMessages() {
  if (!state.timeline.length) {
    el.messages.innerHTML = `<div class="empty-state"><div><h3>Ready</h3><p>Ask PieCode to inspect the workspace, make a focused edit, or run verification.</p></div></div>`;
    return;
  }
  el.messages.innerHTML = state.timeline.map(renderTimelineItem).join("");
  el.messages.scrollTop = el.messages.scrollHeight;
}

function upsertTimeline(item) {
  const id = String(item?.id || "");
  if (!id) return;
  const idx = state.timeline.findIndex((entry) => entry.id === id);
  if (idx >= 0) state.timeline[idx] = { ...state.timeline[idx], ...item };
  else state.timeline.push(item);
  renderMessages();
}

function patchTimeline(id, patch) {
  const idx = state.timeline.findIndex((entry) => entry.id === id);
  if (idx < 0) return;
  state.timeline[idx] = { ...state.timeline[idx], ...(patch || {}) };
  renderMessages();
}

function approvalTitle(item) {
  const kind = String(item.kind || "approval");
  if (kind === "shell") return "Shell command requires approval";
  if (kind === "mcp" || kind.startsWith("mcp")) return "MCP tool requires approval";
  return "Action requires approval";
}

function approvalCommand(item) {
  const details = item.details || {};
  return details.command || details.normalizedCommand || details.input?.command || details.tool || details.question || item.kind || "approval request";
}

function approvalReason(item) {
  const details = item.details || {};
  return details.classification?.reason || details.reason || details.question || "Review this action before PieCode continues.";
}

function renderClarifications() {
  const clarificationHtml = state.clarifications
    .map((item) => `<div class="approval-item clarification-item">
      <strong>${escapeHtml(item.question || "Clarification needed")}</strong>
      <div class="muted">Choose ${item.multiple ? "one or more options" : "one option"} so PieCode can continue.</div>
      <div class="approval-actions clarification-actions">
        ${(Array.isArray(item.options) ? item.options : []).map((option, index) => `<button class="secondary" data-clarification="${escapeHtml(item.id)}" data-option-index="${index}">
          ${escapeHtml(option.label || option.value || `Option ${index + 1}`)}${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}
        </button>`).join("")}
        ${item.required ? "" : `<button class="danger" data-clarification="${escapeHtml(item.id)}" data-option-index="">Skip</button>`}
      </div>
    </div>`)
    .join("");

  document.body.classList.toggle("has-clarifications", state.clarifications.length > 0);
  return clarificationHtml;
}

function renderApprovals() {
  const clarificationHtml = renderClarifications();
  const approvalHtml = state.approvals
    .map((item) => `<div class="approval-item">
      <strong>${escapeHtml(approvalTitle(item))}</strong>
      <code>${escapeHtml(approvalCommand(item))}</code>
      <div class="muted">${escapeHtml(approvalReason(item))}</div>
      <div class="approval-actions">
        <button class="good" data-approval="${escapeHtml(item.id)}" data-decision="allow_once">Allow once</button>
        <button class="secondary" data-approval="${escapeHtml(item.id)}" data-decision="remember_command">Remember command</button>
        <button class="secondary" data-approval="${escapeHtml(item.id)}" data-decision="allow_all_session">Allow all session</button>
        <button class="danger" data-approval="${escapeHtml(item.id)}" data-decision="deny">Deny</button>
      </div>
    </div>`)
    .join("");

  const pendingCount = state.approvals.length + state.clarifications.length;
  document.body.classList.toggle("has-approvals", pendingCount > 0);
  if (!pendingCount) {
    el.approvalList.className = "muted";
    el.approvalList.innerHTML = "No pending approvals";
    el.mobileApprovalPanel.hidden = true;
    el.mobileApprovalList.innerHTML = "";
    return;
  }
  const combinedHtml = `${clarificationHtml}${approvalHtml}`;
  el.approvalList.className = "";
  el.approvalList.innerHTML = combinedHtml;
  el.mobileApprovalPanel.hidden = false;
  el.mobileApprovalList.innerHTML = combinedHtml;
}

function renderSessions() {
  el.sessionIdLabel.textContent = state.sessionId || "-";
  if (!state.recentSessions.length) {
    el.recentSessions.className = "muted";
    el.recentSessions.innerHTML = "No previous sessions";
    return;
  }
  el.recentSessions.className = "";
  el.recentSessions.innerHTML = state.recentSessions
    .slice(0, 3)
    .map((item) => {
      const shortId = item.shortId || String(item.sessionId || "").slice(-6);
      const summary = item.summary || "Web session";
      return `<button class="session-item" data-resume="${escapeHtml(shortId)}">
        <code>${escapeHtml(shortId)}</code>
        <span>${escapeHtml(summary)}</span>
      </button>`;
    })
    .join("");
}

function renderTodos() {
  if (!state.todos.length) {
    el.todoList.className = "muted";
    el.todoList.innerHTML = "No todos yet";
    return;
  }
  el.todoList.className = "";
  el.todoList.innerHTML = state.todos
    .map((todo) => {
      const status = String(todo.status || "pending");
      const mark = status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]";
      return `<div class="todo-item ${escapeHtml(status)}"><span class="todo-mark">${mark}</span><span>${escapeHtml(todo.content)}</span></div>`;
    })
    .join("");
}

function commandInsertText(command) {
  const name = String(command?.name || command || "").trim();
  if (!name) return "";
  if (["/skills use", "/skills off", "/use", "/plan", "/approve", "/detail", "/btw"].includes(name)) return `${name} `;
  return name;
}

function getSlashQuery() {
  const value = el.messageInput.value;
  const cursor = el.messageInput.selectionStart ?? value.length;
  const before = value.slice(0, cursor);
  if (!before.startsWith("/") || before.includes("\n")) return null;
  return before.toLowerCase();
}

function renderSlashSuggestions() {
  const query = getSlashQuery();
  if (query === null) {
    el.slashSuggestions.hidden = true;
    el.slashSuggestions.innerHTML = "";
    return;
  }
  const commands = state.slashCommands.length ? state.slashCommands : [
    { name: "/help", description: "Show web slash commands" },
    { name: "/plan", description: "Show or change plan mode" },
    { name: "/skills", description: "Show active skills" },
  ];
  const hits = commands
    .filter((command) => String(command.name || "").toLowerCase().startsWith(query))
    .slice(0, 8);
  if (!hits.length) {
    el.slashSuggestions.hidden = true;
    el.slashSuggestions.innerHTML = "";
    return;
  }
  state.selectedSuggestion = Math.min(state.selectedSuggestion, hits.length - 1);
  el.slashSuggestions.hidden = false;
  el.slashSuggestions.innerHTML = hits.map((command, index) => `<button type="button" class="suggestion ${index === state.selectedSuggestion ? "active" : ""}" data-command="${escapeHtml(commandInsertText(command))}">
    <span>${escapeHtml(command.name)}</span>
    <small>${escapeHtml(command.description || command.skillName || "")}</small>
  </button>`).join("");
}

function applySuggestion(commandText) {
  const text = String(commandText || "");
  if (!text) return;
  el.messageInput.value = text;
  el.messageInput.focus();
  el.messageInput.setSelectionRange(text.length, text.length);
  renderSlashSuggestions();
}

function pushEvent(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return;
  state.recentEvents.unshift(clean);
  state.recentEvents = state.recentEvents.slice(0, 3);
  el.eventStrip.textContent = state.recentEvents.join(" · ");
}

function renderDiffHtml(diffText) {
  const lines = String(diffText || "").split("\n");
  return lines.map((line) => {
    let cls = "diff-line";
    if (line.startsWith("@@")) cls += " hunk";
    else if (line.startsWith("+") && !line.startsWith("+++")) cls += " add";
    else if (line.startsWith("-") && !line.startsWith("---")) cls += " del";
    else if (line.startsWith("diff --git") || line.startsWith("# ")) cls += " file";
    return `<span class="${cls}">${escapeHtml(line || " ")}</span>`;
  }).join("\n");
}

function attachmentTotalBytes(next = []) {
  return next.reduce((total, item) => total + Number(item.bytes || 0), 0);
}

function fileToAttachment(file) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      reject(new Error(`Unsupported image type: ${file.type || file.name}`));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error(`${file.name} is too large (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB)`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Unable to read ${file.name}`));
    reader.onload = () => {
      const raw = String(reader.result || "");
      const data = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
      resolve({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: "image",
        name: file.name || "image",
        mimeType: file.type,
        data,
        bytes: file.size,
      });
    };
    reader.readAsDataURL(file);
  });
}

function renderAttachmentTray() {
  if (!el.attachmentTray) return;
  if (!state.attachments.length) {
    el.attachmentTray.hidden = true;
    el.attachmentTray.innerHTML = "";
    return;
  }
  el.attachmentTray.hidden = false;
  el.attachmentTray.innerHTML = state.attachments.map((item) => {
    const src = attachmentSrc(item);
    const kb = Math.max(1, Math.round(Number(item.bytes || 0) / 1024));
    return `<div class="attachment-chip" data-attachment="${escapeHtml(item.id)}">
      ${src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(item.name || "image")}" />` : ""}
      <span>${escapeHtml(item.name || "image")} · ${kb}KB</span>
      <button type="button" data-remove-attachment="${escapeHtml(item.id)}" aria-label="Remove attachment">×</button>
    </div>`;
  }).join("");
}

async function addAttachmentFiles(files) {
  const list = [...(files || [])].filter((file) => ALLOWED_IMAGE_TYPES.has(file.type));
  if (!list.length) return;
  try {
    const next = [...state.attachments];
    for (const file of list) {
      if (next.length >= MAX_ATTACHMENTS) throw new Error(`Too many images (max ${MAX_ATTACHMENTS})`);
      const attachment = await fileToAttachment(file);
      if (attachmentTotalBytes([...next, attachment]) > MAX_ATTACHMENTS_BYTES) {
        throw new Error(`Images are too large (max ${Math.round(MAX_ATTACHMENTS_BYTES / 1024 / 1024)}MB total)`);
      }
      next.push(attachment);
    }
    state.attachments = next;
    renderAttachmentTray();
    pushEvent(`${list.length} image${list.length === 1 ? "" : "s"} attached`);
  } catch (err) {
    pushEvent(err.message);
  }
}

function clearAttachments() {
  state.attachments = [];
  if (el.imageInput) el.imageInput.value = "";
  renderAttachmentTray();
}

function closeDiffOverlay() {
  el.diffOverlay.hidden = true;
}

async function openDiffOverlay() {
  el.diffOverlay.hidden = false;
  el.diffMeta.textContent = "Loading working tree changes...";
  el.diffBody.innerHTML = `<div class="diff-loading">Loading diff...</div>`;
  try {
    const res = await fetch(apiUrl("/api/session/diff"));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    if (!data.ok && data.error) {
      el.diffMeta.textContent = "Diff unavailable.";
      el.diffBody.innerHTML = `<div class="diff-empty">${escapeHtml(data.error)}</div>`;
      return;
    }
    const untrackedCount = Array.isArray(data.untrackedFiles) ? data.untrackedFiles.length : 0;
    const truncated = data.truncated ? ` · truncated${data.omittedChars ? ` (${data.omittedChars} chars omitted)` : ""}` : "";
    el.diffMeta.textContent = `Generated ${timeLabel(data.generatedAt)} · ${untrackedCount} untracked file(s)${truncated}`;
    if (!String(data.diff || "").trim()) {
      el.diffBody.innerHTML = `<div class="diff-empty">No tracked changes or untracked files in this workspace.</div>`;
      return;
    }
    el.diffBody.innerHTML = `<pre class="session-diff"><code>${renderDiffHtml(data.diff)}</code></pre>`;
  } catch (err) {
    el.diffMeta.textContent = "Diff request failed.";
    el.diffBody.innerHTML = `<div class="diff-empty error">${escapeHtml(err.message)}</div>`;
  }
}

function applySnapshot(snapshot) {
  state.sessionId = snapshot.shortSessionId || snapshot.sessionId || state.sessionId;
  if (Array.isArray(snapshot.recentSessions)) state.recentSessions = snapshot.recentSessions;
  if (Array.isArray(snapshot.messages)) state.messages = snapshot.messages;
  if (Array.isArray(snapshot.timeline)) state.timeline = snapshot.timeline;
  else state.timeline = state.messages.map((msg) => ({ ...msg, type: "message" }));
  if (Array.isArray(snapshot.approvals)) state.approvals = snapshot.approvals;
  if (Array.isArray(snapshot.clarifications)) state.clarifications = snapshot.clarifications;
  if (Array.isArray(snapshot.todos)) state.todos = snapshot.todos;
  if (Array.isArray(snapshot.slashCommands)) state.slashCommands = snapshot.slashCommands;
  renderStatus(snapshot);
  renderMessages();
  renderApprovals();
  renderSessions();
  renderTodos();
}

function handleEvent(event) {
  const type = event.type;
  const payload = event.payload || {};
  if (type === "snapshot" || type === "ready") {
    applySnapshot(payload);
    return;
  }
  if (type === "message") {
    state.messages.push(payload);
    upsertTimeline({ ...payload, type: "message" });
    return;
  }
  if (type === "timeline") {
    upsertTimeline(payload);
    return;
  }
  if (type === "timeline.update") {
    patchTimeline(payload.id, payload.patch);
    return;
  }
  if (type === "approval.request") {
    state.approvals = [payload, ...state.approvals.filter((item) => item.id !== payload.id)];
    renderApprovals();
    pushEvent("Approval required");
    return;
  }
  if (type === "approval.resolved") {
    state.approvals = state.approvals.filter((item) => item.id !== payload.id);
    renderApprovals();
    pushEvent(`Approval ${payload.decision}`);
    return;
  }
  if (type === "clarification.request") {
    state.clarifications = [payload, ...state.clarifications.filter((item) => item.id !== payload.id)];
    renderApprovals();
    pushEvent("Clarification required");
    return;
  }
  if (type === "clarification.resolved") {
    state.clarifications = state.clarifications.filter((item) => item.id !== payload.id);
    renderApprovals();
    pushEvent("Clarification answered");
    return;
  }
  if (type === "todos") {
    state.todos = payload.todos || [];
    renderTodos();
    return;
  }
  if (type === "sessions") {
    if (Array.isArray(payload.recent)) state.recentSessions = payload.recent;
    renderSessions();
    return;
  }
  if (type === "context.update") {
    renderStatus({ contextUsage: payload.contextUsage || {} });
    return;
  }
  if (type === "llm_response" && payload.usage) {
    renderStatus({
      contextUsage: {
        ...(state.status.contextUsage || {}),
        last: payload.usage,
      },
    });
    return;
  }
  if (type === "task.start") {
    renderStatus({ running: true, activeTask: payload.input });
    pushEvent("Task started");
    return;
  }
  if (type === "task.done") {
    renderStatus({ running: false, activeTask: "" });
    pushEvent("Task completed");
    return;
  }
  if (type === "task.error") {
    renderStatus({ running: false, activeTask: "", lastError: payload.error || "error" });
    pushEvent(payload.error || "Task failed");
    return;
  }
  if (type === "tool_use" || type === "tool_start") {
    pushEvent(`Tool: ${payload.tool || "tool"}`);
    return;
  }
  if (type === "plan" || type === "replan") {
    pushEvent(`Plan: ${payload.plan?.summary || "created"}`);
    return;
  }
  if (type === "thought") {
    pushEvent(payload.content || "Thinking update");
    return;
  }
  if (type === "log") {
    pushEvent(payload.line || payload.message || "Log update");
    return;
  }
  if (type === "model_call" || type === "planning_call" || type === "replanning_call") {
    pushEvent("Model call started");
  }
}

async function postJson(url, body) {
  const res = await fetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json", ...(authToken ? { "x-piecode-token": authToken } : {}) },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res.json().catch(() => ({}));
}

async function loadInitialState() {
  const res = await fetch(apiUrl("/api/state"), { headers: authToken ? { "x-piecode-token": authToken } : {} });
  if (res.ok) applySnapshot(await res.json());
}

function connectEvents() {
  const source = new EventSource(apiUrl("/api/events"));
  source.onopen = () => {
    state.connected = true;
    el.connection.textContent = "online";
    el.connection.className = "pill online";
  };
  source.onerror = () => {
    state.connected = false;
    el.connection.textContent = "reconnecting";
    el.connection.className = "pill";
  };
  const eventTypes = [
    "snapshot", "ready", "message", "timeline", "timeline.update", "approval.request", "approval.resolved", "clarification.request", "clarification.resolved", "todos", "sessions",
    "task.start", "task.done", "task.error", "tool_use", "tool_start", "tool_end",
    "plan", "replan", "thought", "log", "model_call", "planning_call", "replanning_call", "llm_response", "context.update",
  ];
  for (const type of eventTypes) {
    source.addEventListener(type, (raw) => {
      try { handleEvent(JSON.parse(raw.data)); } catch {}
    });
  }
}

el.composer.addEventListener("submit", async (evt) => {
  evt.preventDefault();
  let message = el.messageInput.value.trim();
  if ((!message && !state.attachments.length) || state.running) return;
  if (!message && state.attachments.length) message = "Please inspect the attached image.";
  const attachments = state.attachments.map(({ type, name, mimeType, data, bytes }) => ({ type, name, mimeType, data, bytes }));
  el.messageInput.value = "";
  try {
    await postJson("/api/messages", { message, planOnly: el.planOnly.checked, attachments });
    clearAttachments();
  } catch (err) {
    el.messageInput.value = message;
    upsertTimeline({ id: `local-error-${Date.now()}`, type: "message", role: "error", content: err.message, at: new Date().toISOString() });
  }
});

el.messageInput.addEventListener("input", () => {
  state.selectedSuggestion = 0;
  renderSlashSuggestions();
});

el.messageInput.addEventListener("keydown", (evt) => {
  const visibleSuggestions = !el.slashSuggestions.hidden;
  const buttons = [...el.slashSuggestions.querySelectorAll("button[data-command]")];
  if (visibleSuggestions && buttons.length && (evt.key === "ArrowDown" || evt.key === "ArrowUp")) {
    evt.preventDefault();
    const delta = evt.key === "ArrowDown" ? 1 : -1;
    state.selectedSuggestion = (state.selectedSuggestion + delta + buttons.length) % buttons.length;
    renderSlashSuggestions();
    return;
  }
  if (visibleSuggestions && buttons.length && (evt.key === "Tab" || evt.key === "Enter") && el.messageInput.value.startsWith("/")) {
    evt.preventDefault();
    applySuggestion(buttons[state.selectedSuggestion]?.dataset.command || buttons[0].dataset.command);
    return;
  }
  if (evt.key === "Escape" && visibleSuggestions) {
    evt.preventDefault();
    el.slashSuggestions.hidden = true;
    return;
  }
  if (evt.key === "Enter" && !evt.shiftKey) {
    evt.preventDefault();
    el.composer.requestSubmit();
  }
});

el.slashSuggestions.addEventListener("click", (evt) => {
  const button = evt.target.closest("button[data-command]");
  if (!button) return;
  applySuggestion(button.dataset.command);
});

el.attachBtn?.addEventListener("click", () => el.imageInput?.click());
el.imageInput?.addEventListener("change", () => addAttachmentFiles(el.imageInput.files));
el.attachmentTray?.addEventListener("click", (evt) => {
  const button = evt.target.closest("button[data-remove-attachment]");
  if (!button) return;
  state.attachments = state.attachments.filter((item) => item.id !== button.dataset.removeAttachment);
  renderAttachmentTray();
});
el.messageInput.addEventListener("paste", (evt) => {
  const files = [...(evt.clipboardData?.files || [])].filter((file) => ALLOWED_IMAGE_TYPES.has(file.type));
  if (files.length) addAttachmentFiles(files);
});
el.composer.addEventListener("dragover", (evt) => {
  if ([...(evt.dataTransfer?.items || [])].some((item) => String(item.type || "").startsWith("image/"))) {
    evt.preventDefault();
    el.composer.classList.add("drag-over");
  }
});
el.composer.addEventListener("dragleave", () => el.composer.classList.remove("drag-over"));
el.composer.addEventListener("drop", (evt) => {
  const files = [...(evt.dataTransfer?.files || [])].filter((file) => ALLOWED_IMAGE_TYPES.has(file.type));
  if (!files.length) return;
  evt.preventDefault();
  el.composer.classList.remove("drag-over");
  addAttachmentFiles(files);
});

el.slashHelpBtn.addEventListener("click", () => {
  applySuggestion("/help");
});

el.mobileMenuBtn?.addEventListener("click", () => {
  document.body.classList.toggle("sidebar-open");
});

el.mobileCloseMenuBtn?.addEventListener("click", () => {
  document.body.classList.remove("sidebar-open");
});

el.sidebarBackdrop?.addEventListener("click", () => {
  document.body.classList.remove("sidebar-open");
});

el.mobileMoreBtn?.addEventListener("click", () => {
  applySuggestion("/");
});

el.mobileNewBtn?.addEventListener("click", async () => {
  try {
    await postJson("/api/messages", { message: "/clear" });
    document.body.classList.remove("sidebar-open");
  } catch (err) {
    pushEvent(err.message);
  }
});

el.recentSessions.addEventListener("click", async (evt) => {
  const button = evt.target.closest("button[data-resume]");
  if (!button) return;
  button.disabled = true;
  try {
    await postJson("/api/resume", { id: button.dataset.resume });
  } catch (err) {
    pushEvent(err.message);
  } finally {
    button.disabled = false;
  }
});

async function handleApprovalClick(evt) {
  const clarificationButton = evt.target.closest("button[data-clarification]");
  if (clarificationButton) {
    clarificationButton.disabled = true;
    const rawIndex = clarificationButton.dataset.optionIndex;
    const selectedIndexes = rawIndex === "" ? [] : [Number(rawIndex)];
    const id = clarificationButton.dataset.clarification;
    state.clarifications = state.clarifications.filter((item) => item.id !== id);
    renderApprovals();
    try {
      await postJson("/api/clarifications", { id, selectedIndexes });
    } catch (err) {
      pushEvent(err.message);
    }
    return;
  }

  const button = evt.target.closest("button[data-approval]");
  if (!button) return;
  button.disabled = true;
  const id = button.dataset.approval;
  state.approvals = state.approvals.filter((item) => item.id !== id);
  renderApprovals();
  try {
    await postJson("/api/approvals", { id, decision: button.dataset.decision });
  } catch (err) {
    pushEvent(err.message);
  }
}

el.approvalList.addEventListener("click", handleApprovalClick);
el.mobileApprovalList.addEventListener("click", handleApprovalClick);

el.abortBtn.addEventListener("click", async () => {
  await postJson("/api/abort", {});
});

el.mobileAbortBtn?.addEventListener("click", async () => {
  await postJson("/api/abort", {});
});

el.autoApprove.addEventListener("change", async () => {
  await postJson("/api/approve-mode", { enabled: el.autoApprove.checked });
});

el.planOnly.addEventListener("change", () => {
  state.status.planOnly = el.planOnly.checked;
  pushEvent(`Plan mode ${el.planOnly.checked ? "on" : "off"}`);
});

el.detailMode.addEventListener("change", async () => {
  state.status.detailMode = el.detailMode.checked;
  renderMessages();
  await postJson("/api/detail-mode", { enabled: el.detailMode.checked });
  pushEvent(`Detail mode ${el.detailMode.checked ? "on" : "off"}`);
});

el.sessionDiffBtn.addEventListener("click", () => {
  openDiffOverlay();
});

el.refreshDiffBtn.addEventListener("click", () => {
  openDiffOverlay();
});

el.closeDiffBtn.addEventListener("click", () => {
  closeDiffOverlay();
});

el.diffOverlay.addEventListener("click", (evt) => {
  if (evt.target === el.diffOverlay) closeDiffOverlay();
});

document.addEventListener("keydown", (evt) => {
  if (evt.key === "Escape" && !el.diffOverlay.hidden) closeDiffOverlay();
  if (evt.key === "Escape") document.body.classList.remove("sidebar-open");
});

loadInitialState().catch(() => {});
connectEvents();
renderMessages();
