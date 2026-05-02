const state = {
  connected: false,
  running: false,
  messages: [],
  timeline: [],
  approvals: [],
  todos: [],
  slashCommands: [],
  selectedSuggestion: 0,
  status: {},
  recentEvents: [],
  recentSessions: [],
  sessionId: "",
};

const el = {
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  activeTask: document.getElementById("activeTask"),
  modelLabel: document.getElementById("modelLabel"),
  workspaceLabel: document.getElementById("workspaceLabel"),
  mcpLabel: document.getElementById("mcpLabel"),
  connection: document.getElementById("connection"),
  messages: document.getElementById("messages"),
  composer: document.getElementById("composer"),
  messageInput: document.getElementById("messageInput"),
  sendBtn: document.getElementById("sendBtn"),
  slashSuggestions: document.getElementById("slashSuggestions"),
  slashHelpBtn: document.getElementById("slashHelpBtn"),
  abortBtn: document.getElementById("abortBtn"),
  planOnly: document.getElementById("planOnly"),
  autoApprove: document.getElementById("autoApprove"),
  approvalList: document.getElementById("approvalList"),
  sessionIdLabel: document.getElementById("sessionIdLabel"),
  recentSessions: document.getElementById("recentSessions"),
  todoList: document.getElementById("todoList"),
  eventStrip: document.getElementById("eventStrip"),
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
    .replace(/```([\s\S]*?)```/g, (_m, code) => `<pre><code>${code}</code></pre>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function renderStatus(snapshot = {}) {
  state.status = { ...state.status, ...(snapshot || {}) };
  snapshot = state.status;
  state.running = Boolean(snapshot.running);
  el.statusDot.className = `dot ${snapshot.lastError ? "error" : state.running ? "running" : "idle"}`;
  el.statusText.textContent = snapshot.lastError ? "Error" : state.running ? "Running" : "Idle";
  el.activeTask.textContent = snapshot.activeTask || (state.connected ? "Ready" : "Connecting...");
  el.modelLabel.textContent = snapshot.providerLabel || snapshot.model || "-";
  el.workspaceLabel.textContent = shortPath(snapshot.workspaceDir);
  el.mcpLabel.textContent = Array.isArray(snapshot.mcpServers) && snapshot.mcpServers.length ? snapshot.mcpServers.join(", ") : "none";
  el.autoApprove.checked = Boolean(snapshot.autoApprove);
  el.planOnly.checked = Boolean(snapshot.planOnly);
  el.abortBtn.disabled = !state.running;
  el.sendBtn.disabled = state.running;
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
    </article>`;
  }
  if (item.type === "tool") {
    const status = String(item.status || "queued");
    const subject = toolSubject(item);
    return `<article class="tool-card ${escapeHtml(status)}" data-id="${escapeHtml(item.id)}">
      <div class="tool-head">
        <span class="tool-icon">${status === "done" ? "✓" : status === "error" ? "!" : "↯"}</span>
        <div>
          <strong>${escapeHtml(toolTitle(item))}</strong>
          ${subject ? `<code>${escapeHtml(subject)}</code>` : ""}
        </div>
        <span class="tool-status">${escapeHtml(status)}</span>
      </div>
      ${item.reason ? `<div class="tool-reason">${escapeHtml(item.reason)}</div>` : ""}
      ${item.error ? `<div class="tool-error">${escapeHtml(item.error)}</div>` : ""}
      ${renderToolResult(item.result)}
    </article>`;
  }
  return "";
}

function renderMessages() {
  if (!state.timeline.length) {
    el.messages.innerHTML = `<div class="empty-state"><div><h3>Ready to cook</h3><p>Ask for an inspection, a small edit, or a test run. Tool calls and file diffs will appear inline here.</p></div></div>`;
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

function approvalCommand(item) {
  const details = item.details || {};
  return details.command || details.normalizedCommand || details.input?.command || "approval request";
}

function approvalReason(item) {
  const details = item.details || {};
  return details.classification?.reason || details.reason || details.question || "Manual approval required";
}

function renderApprovals() {
  if (!state.approvals.length) {
    el.approvalList.className = "muted";
    el.approvalList.innerHTML = "No pending approvals";
    return;
  }
  el.approvalList.className = "";
  el.approvalList.innerHTML = state.approvals
    .map((item) => `<div class="approval-item">
      <strong>${escapeHtml(item.kind === "shell" ? "Shell command" : item.kind)}</strong>
      <code>${escapeHtml(approvalCommand(item))}</code>
      <div class="muted">${escapeHtml(approvalReason(item))}</div>
      <div class="approval-actions">
        <button class="good" data-approval="${escapeHtml(item.id)}" data-decision="allow_once">Once</button>
        <button class="secondary" data-approval="${escapeHtml(item.id)}" data-decision="remember_command">Remember</button>
        <button class="secondary" data-approval="${escapeHtml(item.id)}" data-decision="allow_all_session">All session</button>
        <button class="danger" data-approval="${escapeHtml(item.id)}" data-decision="deny">Deny</button>
      </div>
    </div>`)
    .join("");
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
  if (["/skills use", "/skills off", "/use", "/plan", "/approve"].includes(name)) return `${name} `;
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

function applySnapshot(snapshot) {
  state.sessionId = snapshot.shortSessionId || snapshot.sessionId || state.sessionId;
  if (Array.isArray(snapshot.recentSessions)) state.recentSessions = snapshot.recentSessions;
  if (Array.isArray(snapshot.messages)) state.messages = snapshot.messages;
  if (Array.isArray(snapshot.timeline)) state.timeline = snapshot.timeline;
  else state.timeline = state.messages.map((msg) => ({ ...msg, type: "message" }));
  if (Array.isArray(snapshot.approvals)) state.approvals = snapshot.approvals;
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
  if (type === "plan") {
    pushEvent(`Plan: ${payload.plan?.summary || "created"}`);
    return;
  }
  if (type === "thought") {
    pushEvent(payload.content || "Thinking update");
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res.json().catch(() => ({}));
}

async function loadInitialState() {
  const res = await fetch("/api/state");
  if (res.ok) applySnapshot(await res.json());
}

function connectEvents() {
  const source = new EventSource("/api/events");
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
    "snapshot", "ready", "message", "timeline", "timeline.update", "approval.request", "approval.resolved", "todos", "sessions",
    "task.start", "task.done", "task.error", "tool_use", "tool_start", "tool_end",
    "plan", "replan", "thought", "log",
  ];
  for (const type of eventTypes) {
    source.addEventListener(type, (raw) => {
      try { handleEvent(JSON.parse(raw.data)); } catch {}
    });
  }
}

el.composer.addEventListener("submit", async (evt) => {
  evt.preventDefault();
  const message = el.messageInput.value.trim();
  if (!message || state.running) return;
  el.messageInput.value = "";
  try {
    await postJson("/api/messages", { message, planOnly: el.planOnly.checked });
  } catch (err) {
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

el.slashHelpBtn.addEventListener("click", () => {
  applySuggestion("/help");
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

el.approvalList.addEventListener("click", async (evt) => {
  const button = evt.target.closest("button[data-approval]");
  if (!button) return;
  button.disabled = true;
  try {
    await postJson("/api/approvals", { id: button.dataset.approval, decision: button.dataset.decision });
  } catch (err) {
    pushEvent(err.message);
  }
});

el.abortBtn.addEventListener("click", async () => {
  await postJson("/api/abort", {});
});

el.autoApprove.addEventListener("change", async () => {
  await postJson("/api/approve-mode", { enabled: el.autoApprove.checked });
});

el.planOnly.addEventListener("change", () => {
  state.status.planOnly = el.planOnly.checked;
  pushEvent(`Plan mode ${el.planOnly.checked ? "on" : "off"}`);
});

loadInitialState().catch(() => {});
connectEvents();
renderMessages();
