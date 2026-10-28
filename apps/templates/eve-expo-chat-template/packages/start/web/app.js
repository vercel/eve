import {
  applyConversationPatch,
  compareChatMessages,
  messageSegments,
  toolLabel,
} from "../../protocol/src/conversation.ts";
import { marked } from "marked";
import DOMPurify from "dompurify";
import RFB from "@novnc/novnc";
const $ = (id) => document.getElementById(id);
let passwordMode = false;
let connected = false,
  polling = false,
  eventSource,
  latestSnapshot = 0;
let messages = [],
  streams = [],
  browserState;
const outbox = new Map(),
  nodes = new Map();
let stickToBottom = true,
  streamActivity = 0;
const mobileViewport = window.matchMedia("(max-width:680px)");
let mobileBrowserVisible = false;
let activeResponse = null,
  stoppingResponse = false;
function updateBrowserToggle() {
  const visible = !mobileViewport.matches || mobileBrowserVisible;
  $("toggle-browser").hidden =
    !connected || !mobileViewport.matches || browserState?.cloudAvailable === false;
  $("toggle-browser").textContent = visible ? "Hide browser" : "Show browser";
  $("toggle-browser").setAttribute("aria-expanded", String(visible));
  return visible;
}
$("toggle-browser").onclick = () => {
  mobileBrowserVisible = !mobileBrowserVisible;
  previewAttempt = 0;
  if (browserState) renderDock(browserState);
};
mobileViewport.addEventListener("change", () => {
  mobileBrowserVisible = false;
  if (browserState) renderDock(browserState);
});
let preview,
  previewBusy = false,
  previewGeneration = 0,
  previewAttempt = 0;
const settings = $("connections-dialog"),
  mobileSettings = $("mobile-dialog");
function openSettings() {
  if (mobileSettings.open) mobileSettings.close();
  closeSidebar();
  settings.showModal();
}
$("browser-settings").onclick = () => openSettings();
$("nav-mobile").onclick = () => {
  if (settings.open) settings.close();
  closeSidebar();
  mobileSettings.showModal();
  $("pair-code-timer").hidden = !connected;
  if (!connected) {
    $("phone-code").hidden = false;
    $("pair-code").textContent = "";
    $("pair-code-status").textContent = "Connect an agent first.";
    $("copy-pair-code").disabled = true;
  } else void refreshPairingCode();
};
$("close-settings").onclick = () => settings.close();
$("close-mobile").onclick = () => mobileSettings.close();
for (const dialog of [settings, mobileSettings])
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        dialog.close();
    }
  });
function closeSidebar() {
  document.querySelector(".sidebar").classList.remove("open");
  $("sidebar-backdrop").hidden = true;
}
$("toggle-sidebar").onclick = () => {
  const open = document.querySelector(".sidebar").classList.toggle("open");
  $("sidebar-backdrop").hidden = !open;
};
$("sidebar-backdrop").onclick = closeSidebar;
$("nav-chat").onclick = () => {
  closeSidebar();
  $("message").focus();
};
function closePreview() {
  previewGeneration++;
  const old = preview;
  preview = undefined;
  old?.disconnect();
  $("preview-screen").replaceChildren();
  $("cloud-preview").dataset.live = "false";
}
async function connectPreview() {
  if (
    (mobileViewport.matches && !mobileBrowserVisible) ||
    preview ||
    previewBusy ||
    !connected ||
    !browserState?.browserReady ||
    Date.now() - previewAttempt < 5000
  )
    return;
  previewBusy = true;
  previewAttempt = Date.now();
  const generation = previewGeneration;
  $("preview-label").textContent = "Connecting to live browser…";
  try {
    const result = await api("desktop/stream", {});
    if (generation !== previewGeneration || !connected) return;
    if (!result.url) throw Error("Browser is still starting");
    const url = new URL(result.url);
    if (
      url.protocol !== "wss:" ||
      !url.hostname.endsWith(".vercel.run") ||
      url.pathname !== "/websockify"
    )
      throw Error("Invalid preview connection");
    const rfb = new RFB($("preview-screen"), url.href, { shared: true });
    preview = rfb;
    rfb.viewOnly = true;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.focusOnClick = false;
    rfb.addEventListener("connect", () => {
      if (preview !== rfb) return;
      $("cloud-preview").dataset.live = "true";
      $("preview-dot").dataset.ready = "true";
      $("dock-status").textContent = "Live";
    });
    rfb.addEventListener("disconnect", () => {
      if (preview !== rfb) return;
      preview = undefined;
      $("cloud-preview").dataset.live = "false";
      $("preview-dot").dataset.ready = "false";
      $("preview-label").textContent = "Reconnecting…";
      $("dock-status").textContent = "Connection interrupted";
    });
    rfb.addEventListener("securityfailure", () => {
      $("preview-label").textContent = "Preview unavailable · click to reopen";
    });
  } catch (e) {
    $("preview-label").textContent = "Preview offline. Click to open.";
    $("dock-status").textContent = "Waiting for the browser";
  } finally {
    previewBusy = false;
  }
}
function renderDock(state) {
  const ready = Boolean(state.browserReady);
  const visible = updateBrowserToggle();
  $("browser-dock").hidden = !connected || !visible || state.cloudAvailable === false;
  if (!visible) {
    closePreview();
    return;
  }
  if (ready) {
    if (!preview) $("dock-status").textContent = "Connecting to the live view";
    void connectPreview();
  } else {
    if (preview) closePreview();
    $("preview-dot").dataset.ready = "false";
    $("preview-label").textContent =
      state.remoteDesktop?.state === "starting"
        ? "Starting your cloud browser…"
        : "Sleeping. Click to start.";
    $("dock-status").textContent = "Sleeping";
  }
}
function openBrowser() {
  $("remote").click();
}
$("browser-expand").onclick = openBrowser;
$("preview-overlay").onclick = openBrowser;

async function api(path, body, method) {
  const response = await fetch("/v1/web/" + path, {
    method: method || (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) setConnected(false);
    throw Error(data.error || "Request failed");
  }
  return data;
}
function error(e) {
  $("error").textContent = e.message || String(e);
}
function startEvents() {
  if (eventSource || !connected) return;
  eventSource = new EventSource("/v1/web/events?v=2");
  eventSource.addEventListener("conversation", (event) => {
    try {
      streamActivity = Date.now();
      renderConversation(JSON.parse(event.data), true);
      $("live-status").textContent = "Live";
    } catch (e) {
      error(e);
    }
  });
  eventSource.addEventListener("conversation.patch", (event) => {
    try {
      streamActivity = Date.now();
      renderConversation(
        applyConversationPatch({ asOf: latestSnapshot, messages, streams }, JSON.parse(event.data)),
        true,
      );
    } catch (e) {
      error(e);
    }
  });
  eventSource.addEventListener("heartbeat", () => {
    streamActivity = Date.now();
  });
  eventSource.onopen = () => {
    $("live-status").textContent = "Live";
  };
  eventSource.onerror = () => {
    streamActivity = 0;
    if (connected) $("live-status").textContent = "Reconnecting…";
  };
}
function setConnected(value) {
  connected = value;
  document.body.classList.toggle("paired", value);
  document.querySelector(".chat").classList.toggle("connected", value);
  $("pair-panel").hidden = value;
  $("messages").hidden = !value;
  $("suggestions").hidden = !value;
  $("logout").hidden = !value;
  for (const id of ["message", "send", "remote"]) $(id).disabled = !value;
  $("browser-dock").hidden = !value || !updateBrowserToggle();
  if (value) {
    startEvents();
    if (mobileSettings.open) void refreshPairingCode();
  } else {
    mobileBrowserVisible = false;
    updateBrowserToggle();
    settings.close();
    mobileSettings.close();
    clearTimeout(pairingRefresh);
    pairingCode = "";
    $("phone-code").hidden = true;
    closePreview();
    eventSource?.close();
    eventSource = undefined;
    streamActivity = 0;
    $("agent-name").textContent = "Chat with eve";
    $("live-status").textContent = "Web chat";
    $("thinking").hidden = true;
    activeResponse = null;
    updateComposerAction();
    $("model-name").hidden = true;
  }
}
function markdown(text, node) {
  node.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "style", "form", "input", "button", "video", "audio"],
    FORBID_ATTR: ["style", "id", "name"],
  });
  for (const link of node.querySelectorAll("a")) {
    try {
      if (
        !["https:", "http:", "mailto:"].includes(
          new URL(link.getAttribute("href"), location.href).protocol,
        )
      )
        link.removeAttribute("href");
    } catch {
      link.removeAttribute("href");
    }
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
}
function renderConversation(state, live = false) {
  if (!live && streamActivity && Date.now() - streamActivity < 15000) return;
  if (!live && (state.asOf || 0) < latestSnapshot) return;
  latestSnapshot = Math.max(state.asOf || 0, latestSnapshot);
  messages = state.messages || [];
  streams = state.streams || [];
  activeResponse = state.activeResponse || null;
  updateComposerAction();
  $("model-name").textContent = state.model || "";
  $("model-name").hidden = !connected || !state.model;
  for (const message of messages) {
    const entry = outbox.get(message.id);
    if (entry) {
      entry.status = "sent";
      entry.responseId = message.responseId;
      if (messages.some((m) => m.id === message.responseId)) outbox.delete(message.id);
    }
  }
  paintMessages();
}
function paintMessages(forceScroll = false) {
  const box = $("messages"),
    confirmed = new Set(messages.map((m) => m.id));
  const all = [...messages];
  for (const entry of outbox.values())
    if (!confirmed.has(entry.id)) all.push({ ...entry, role: "user" });
  for (const draft of streams)
    if (!confirmed.has(draft.id)) all.push({ ...draft, streaming: draft.status === "streaming" });
  all.sort(compareChatMessages);
  const keep = new Set();
  for (const message of all) {
    keep.add(message.id);
    const local = outbox.get(message.id),
      status = local?.status || message.status;
    const stamp = JSON.stringify([message.text, message.tools, status, message.streaming]);
    let node = nodes.get(message.id);
    if (!node) {
      node = document.createElement("article");
      node.dataset.messageId = message.id;
      node.innerHTML =
        '<small class="message-role"></small><div class="message-content"></div><div class="message-state"></div>';
      nodes.set(message.id, node);
    }
    if (node.dataset.stamp !== stamp) {
      node.className =
        "message " +
        message.role +
        (message.streaming ? " streaming" : "") +
        (status === "failed" ? " failed" : "");
      node.querySelector(".message-role").textContent = message.role === "user" ? "You" : "eve";
      const content = node.querySelector(".message-content");
      const expanded = new Set(
        [...content.querySelectorAll(".tool-activity[open]")].map((item) => item.dataset.callId),
      );
      content.replaceChildren();
      if (message.role === "assistant") {
        const segments = messageSegments(message);
        for (const segment of segments) {
          if (segment.type === "text") {
            const block = document.createElement("div");
            block.className = "text-part";
            markdown(segment.text, block);
            content.append(block);
          } else {
            const activity = document.createElement("details");
            activity.className = "tool-activity " + segment.status;
            activity.dataset.callId = segment.id;
            activity.open = expanded.has(segment.id);
            const summary = document.createElement("summary");
            const icon = document.createElement("span");
            icon.className = "tool-icon";
            icon.textContent =
              segment.status === "completed"
                ? "✓"
                : ["failed", "interrupted"].includes(segment.status)
                  ? "×"
                  : "";
            const label = document.createElement("span");
            label.textContent = toolLabel(segment.name);
            const state = document.createElement("span");
            state.className = "tool-status";
            state.textContent =
              segment.status === "completed"
                ? "Done"
                : segment.status === "failed"
                  ? "Failed"
                  : segment.status === "interrupted"
                    ? "Interrupted"
                    : segment.status === "preparing"
                      ? "Preparing"
                      : "Running";
            summary.append(icon, label, state);
            const detail = document.createElement("div");
            detail.className = "tool-name";
            detail.textContent = segment.name;
            activity.append(summary, detail);
            content.append(activity);
          }
        }
        if (!segments.length)
          markdown(status === "error" ? "Reply interrupted." : "Thinking…", content);
      } else content.textContent = message.text;
      const indicator = node.querySelector(".message-state");
      indicator.replaceChildren();
      if (status === "sending") indicator.textContent = "Sending…";
      else if (status === "failed") {
        const retry = document.createElement("button");
        retry.textContent = "Not sent · Retry";
        retry.onclick = () => deliver(local);
        indicator.append(retry);
      } else if (status === "sent" && !message.responseId) indicator.textContent = "Sent";
      // Before any text, the reply body already reads "Thinking…"; only label active writing.
      else if (message.streaming)
        indicator.textContent =
          message.text &&
          !message.tools?.some((tool) => ["preparing", "running"].includes(tool.status))
            ? "Writing…"
            : "";
      else if (status === "error")
        indicator.textContent = "Reply interrupted. Partial response saved.";
      node.dataset.stamp = stamp;
    }
    // Keep existing DOM nodes stable as text streams in; avoid rebuilding the conversation.
    const index = all.indexOf(message);
    if (box.children[index] !== node) box.insertBefore(node, box.children[index] || null);
  }
  for (const [id, node] of nodes)
    if (!keep.has(id)) {
      node.remove();
      nodes.delete(id);
    }
  $("welcome").hidden = !connected || all.length > 0;
  $("suggestions").hidden = !connected || all.length > 0;
  const waiting = messages.filter(
    (m) =>
      m.role === "user" &&
      m.pending &&
      !confirmed.has(m.responseId) &&
      !streams.some((s) => s.eventId === m.id),
  );
  const sending = [...outbox.values()].some(
    (m) => m.status === "sending" || (m.status === "sent" && !confirmed.has(m.id)),
  );
  $("thinking").hidden = !waiting.length && !sending;
  $("thinking").textContent = sending ? "Sending your message…" : "eve is thinking…";
  if (forceScroll || stickToBottom) box.scrollTop = box.scrollHeight;
}
function updateComposerAction() {
  const button = $("send");
  button.type = activeResponse ? "button" : "submit";
  button.textContent = activeResponse ? "■" : "↑";
  button.setAttribute("aria-label", activeResponse ? "Stop response" : "Send message");
  button.disabled = !connected || Boolean(activeResponse && stoppingResponse);
}
async function stopResponse() {
  if (!activeResponse || stoppingResponse) return;
  const id = activeResponse;
  stoppingResponse = true;
  updateComposerAction();
  try {
    await api("stop", { id });
  } catch (e) {
    error(e);
  } finally {
    stoppingResponse = false;
    updateComposerAction();
  }
}
$("send").onclick = () => {
  if (activeResponse) void stopResponse();
};
$("messages").addEventListener("scroll", () => {
  const box = $("messages");
  stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 70;
  $("jump-latest").hidden = stickToBottom;
});
$("jump-latest").onclick = () => {
  stickToBottom = true;
  paintMessages(true);
  $("jump-latest").hidden = true;
};
function render(state) {
  browserState = state;
  const ready = Boolean(state.browserReady);
  $("agent-nav-name").textContent = state.name;
  $("agent-name").textContent = state.name;
  const remote = state.remoteDesktop;
  const status =
    state.cloudAvailable === false
      ? "Not configured. Run ./scripts/setup.sh."
      : ready
        ? "Ready"
        : remote?.state === "starting"
          ? "Starting…"
          : remote?.state === "error"
            ? "Needs attention. Open it to retry."
            : "Sleeping. Starts when needed.";
  $("desktop-status").textContent = status;
  // The preview panel shows normal states; the sidebar only flags problems it cannot show.
  $("sidebar-browser-status").textContent = status;
  $("sidebar-browser-status").hidden = state.cloudAvailable !== false && remote?.state !== "error";
  $("stop").hidden = !remote || !["ready", "starting"].includes(remote.state);
  $("remote").disabled = !connected || state.cloudAvailable === false;
  renderConversation(state);
  renderDock(state);
}
async function refresh() {
  if (!connected || polling) return;
  polling = true;
  try {
    render(await api("state"));
  } catch (e) {
    error(e);
  } finally {
    polling = false;
  }
}
async function connect(token) {
  await api("pair", { pairingToken: token });
  setConnected(true);
  $("error").textContent = "";
  await refresh();
}
$("login-form").onsubmit = async (event) => {
  event.preventDefault();
  $("login-button").disabled = true;
  $("login-error").textContent = "";
  try {
    await api("login", { password: $("app-password").value });
    $("app-password").value = "";
    setConnected(true);
    await refresh();
  } catch (e) {
    $("login-error").textContent = e.message;
  } finally {
    $("login-button").disabled = false;
  }
};
$("pair-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await connect($("pair-input").value.trim());
    $("pair-input").value = "";
  } catch (e) {
    error(e);
  }
};
$("logout").onclick = async () => {
  try {
    await api("session", null, "DELETE");
    settings.close();
    mobileSettings.close();
    setConnected(false);
    messages = [];
    streams = [];
    outbox.clear();
    nodes.clear();
    $("messages").replaceChildren();
    latestSnapshot = 0;
  } catch (e) {
    error(e);
  }
};
async function deliver(entry) {
  if (!entry || !connected || entry.inFlight) return;
  entry.inFlight = true;
  entry.status = "sending";
  paintMessages();
  try {
    await api("messages", { id: entry.id, text: entry.text });
    entry.status = "sent";
    $("error").textContent = "";
  } catch (e) {
    if (!messages.some((m) => m.id === entry.id)) {
      entry.status = "failed";
      error(e);
    }
  } finally {
    entry.inFlight = false;
    paintMessages();
  }
}
function send(text) {
  if (!text.trim() || !connected || activeResponse || text.trim().length > 10000) return;
  const entry = {
    id: crypto.randomUUID(),
    text: text.trim(),
    createdAt: Date.now(),
    status: "sending",
  };
  outbox.set(entry.id, entry);
  $("message").value = "";
  $("message").style.height = "";
  stickToBottom = true;
  paintMessages(true);
  $("message").focus();
  void deliver(entry);
}
$("compose").onsubmit = (event) => {
  event.preventDefault();
  send($("message").value);
};
$("message").onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send($("message").value);
  }
};
$("message").oninput = () => {
  $("message").style.height = "auto";
  $("message").style.height = Math.min($("message").scrollHeight, 140) + "px";
};
document
  .querySelectorAll("[data-prompt]")
  .forEach((button) => (button.onclick = () => send(button.dataset.prompt)));
let pairingRefresh,
  expoGoServer = "",
  pairingCode = "",
  pairingRequest = false,
  pairingRefreshAfter = 30000,
  pairingDeadline = 0;
function paintPairingTimer() {
  if (!mobileSettings.open || document.hidden) return;
  const remaining = Math.max(0, Math.min(1, (pairingDeadline - Date.now()) / 30000));
  $("pair-code-progress").style.strokeDashoffset = String(100 * (1 - remaining));
}
setInterval(paintPairingTimer, 100);
async function refreshPairingCode() {
  clearTimeout(pairingRefresh);
  if (!connected || !mobileSettings.open || document.hidden || pairingRequest) return;
  pairingRequest = true;
  const requestedServer = expoGoServer;
  try {
    const p = await api("pairing", requestedServer ? { expoGoUrl: requestedServer } : {});
    if (!connected || requestedServer !== expoGoServer) return;
    pairingRefreshAfter = p.refreshAfterMs || 30000;
    pairingDeadline = Date.now() + pairingRefreshAfter;
    paintPairingTimer();
    pairingCode = p.code;
    $("pair-code").textContent = p.expoGo ? "" : "Native app ·";
    $("pair-instructions").textContent = !p.expoGo
      ? "Scan with a phone that has the native app installed."
      : requestedServer
        ? "Scan to load your local Metro changes."
        : "Scan with your iPhone camera or the Expo Go app on Android.";
    $("pair-qr").hidden = !p.qr;
    if (p.qr) $("pair-qr").src = p.qr;
    $("pair-link").hidden = false;
    $("pair-link").href = p.link;
    $("pair-link").textContent = p.expoGo ? "Open in Expo Go" : "Open native app";
    $("copy-pair-code").textContent = "Copy link";
    $("pair-code-status").textContent = "";
    $("copy-pair-code").disabled = false;
    $("pair-code-timer").hidden = false;
    for (const el of document.querySelectorAll(".pair-meta, .pair-actions")) el.hidden = false;
    $("phone-code").hidden = false;
  } catch (e) {
    // Show why there is no QR in place of it, rather than a stale or unusable code.
    $("copy-pair-code").disabled = true;
    $("pair-qr").hidden = true;
    $("pair-link").hidden = true;
    for (const el of document.querySelectorAll(".pair-meta, .pair-actions")) el.hidden = true;
    $("pair-instructions").textContent = e.message || "Could not create the pairing link.";
    $("pair-code-status").textContent = "";
    $("phone-code").hidden = false;
  } finally {
    pairingRequest = false;
    if (connected && mobileSettings.open && !document.hidden)
      pairingRefresh = setTimeout(
        () => void refreshPairingCode(),
        requestedServer !== expoGoServer ? 0 : pairingRefreshAfter,
      );
  }
}
$("expo-go-form").onsubmit = (event) => {
  event.preventDefault();
  expoGoServer = $("expo-go-url").value.trim();
  $("pair-qr").hidden = true;
  $("pair-link").hidden = true;
  $("copy-pair-code").disabled = true;
  $("pair-code-status").textContent = "Updating pairing link…";
  void refreshPairingCode();
};
mobileSettings.addEventListener("close", () => clearTimeout(pairingRefresh));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshPairingCode();
  else clearTimeout(pairingRefresh);
});
$("copy-pair-code").onclick = async () => {
  try {
    await navigator.clipboard.writeText(pairingCode);
    $("pair-code-status").textContent = "Copied";
  } catch (e) {
    error(e);
  }
};
$("remote").onclick = async () => {
  const popup = window.open("about:blank", "_blank");
  if (popup) {
    popup.opener = null;
    popup.document.body.style.cssText =
      "background:#0a0a0a;color:#ededed;font:13px monospace;padding:32px";
    popup.document.body.textContent = "eve / starting cloud browser…";
  }
  $("remote").disabled = true;
  try {
    await api("desktop", {});
    let ready = false;
    for (let i = 0; i < 90; i++) {
      const s = await api("state");
      render(s);
      if (s.remoteDesktop?.state === "error") throw Error("Sandbox could not start. Try again.");
      if (s.remoteDesktop?.state === "ready") {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!ready) throw Error("Sandbox is still starting. Try opening it again shortly.");
    const result = await api("desktop/link", {});
    const url = new URL(result.url);
    if (url.protocol !== "https:") throw Error("Invalid desktop URL");
    if (popup) popup.location.href = url.href;
    else {
      const a = document.createElement("a");
      a.href = url.href;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.textContent = "Open your desktop ↗";
      $("desktop-status").replaceChildren(a);
    }
  } catch (e) {
    if (popup) popup.close();
    error(e);
  } finally {
    $("remote").disabled = !connected || browserState?.cloudAvailable === false;
  }
};
$("stop").onclick = async () => {
  try {
    $("stop").disabled = true;
    await api("desktop", null, "DELETE");
    await refresh();
  } catch (e) {
    error(e);
  } finally {
    $("stop").disabled = false;
  }
};
(async () => {
  const token = new URLSearchParams(location.hash.slice(1)).get("pair");
  if (token) history.replaceState(null, "", location.pathname);
  try {
    const session = await api("session");
    passwordMode = session.mode === "password";
    $("entry-title").textContent = passwordMode ? "eve Start" : "Connect your agent.";
    $("login-form").hidden = !passwordMode;
    $("pair-form").hidden = passwordMode;
    $("pair-hint").hidden = passwordMode;
    $("logout").textContent = passwordMode ? "Sign out of this browser" : "Disconnect this browser";
    if (passwordMode && session.configured === false) {
      $("login-button").disabled = true;
      $("login-error").textContent = (
        session.setupIssues || ["Run ./scripts/setup.sh in your eve app, then deploy."]
      ).join(" ");
    }
    if (token && !passwordMode) await connect(token);
    else {
      setConnected(session.authenticated);
      if (session.authenticated) render(await api("state"));
    }
  } catch (e) {
    error(e);
  }
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 2500);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
})();
