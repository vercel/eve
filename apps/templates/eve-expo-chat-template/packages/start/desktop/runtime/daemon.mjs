import { createServer } from "node:http";
import { connect as tcpConnect } from "node:net";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { DesktopAccess, same, authorizeDesktopSocket } from "./access.mjs";
import { CloudChrome } from "./chrome.mjs";
import { AgentBrowserRunner } from "./runner.mjs";
import { browserCommand } from "./protocol.mjs";
const folder = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(folder, "config.json"), "utf8"));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
function launch(cmd, args, env = {}) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: "ignore" });
  children.push(child);
  child.on("error", (e) => console.error(`${cmd}: ${e.message}`));
  return child;
}
for (const file of [
  "/tmp/.X99-lock",
  "/tmp/.X11-unix/X99",
  "/data/chrome-profile/SingletonLock",
  "/data/chrome-profile/SingletonSocket",
  "/data/chrome-profile/SingletonCookie",
])
  await unlink(file).catch(() => {});
launch("Xvfb", [":99", "-screen", "0", "1440x1000x24", "-s", "0", "-nolisten", "tcp", "-ac"]);
await pause(700);
launch("openbox", [], { DISPLAY: ":99" });
launch("x11vnc", [
  "-display",
  ":99",
  "-localhost",
  "-rfbport",
  "5900",
  "-nopw",
  "-forever",
  "-shared",
  "-noxdamage",
]);
let startupUrls = ["https://mail.google.com/"];
try {
  const saved = JSON.parse(await readFile("/data/eve-open-tabs.json", "utf8"));
  if (Array.isArray(saved) && saved.length)
    startupUrls = saved.filter((u) => typeof u === "string" && /^https?:/.test(u)).slice(0, 50);
} catch {}
let connected = false,
  stopping = false,
  busy = false,
  firstLaunch = true;
const browser = new AgentBrowserRunner({ cdp: "9222", session: `eve-go-${config.agentId}` });
await browser.prepare();
const chrome = new CloudChrome({
  launch: () => {
    const urls = firstLaunch ? startupUrls : ["about:blank"];
    firstLaunch = false;
    return launch(
      "google-chrome",
      [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--password-store=basic",
        "--user-data-dir=/data/chrome-profile",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9222",
        "--window-size=1440,960",
        "--disk-cache-size=104857600",
        "--media-cache-size=33554432",
        ...urls,
      ],
      { DISPLAY: ":99" },
    );
  },
  health: async () => {
    const response = await fetch("http://127.0.0.1:9222/json/list", {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw Error("Chrome is not ready");
    const tabs = await response.json();
    if (!tabs.some((t) => t.type === "page")) {
      const opened = await fetch("http://127.0.0.1:9222/json/new?about:blank", {
        method: "PUT",
        signal: AbortSignal.timeout(2000),
      });
      if (!opened.ok) throw Error("Could not open a browser tab");
    }
  },
  attach: async () => {
    if (!(await browser.ready())) throw Error("agent-browser could not attach");
  },
  detach: () => browser.detach(),
  onReady: (value) => {
    connected = value;
  },
});
await chrome.start();
const access = new DesktopAccess();
const origin = new URL(config.publicOrigin).origin;
const novnc = join(folder, "node_modules/@novnc/novnc");
const mime = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".html": "text/html",
};
function headers(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
}
function json(res, status, value) {
  headers(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 256 * 1024) throw new Error("Request too large");
  }
  return JSON.parse(raw || "{}");
}
function control(req) {
  return (
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) &&
    same(req.headers.authorization || "", `Bearer ${config.controlKey}`)
  );
}
let shutdownTask;
function shutdown() {
  return (shutdownTask ||= stopDesktop());
}
async function stopDesktop() {
  stopping = true;
  try {
    const pages = await (await fetch("http://127.0.0.1:9222/json/list")).json();
    const urls = pages.filter((p) => p.type === "page" && /^https?:/.test(p.url)).map((p) => p.url);
    await writeFile("/data/eve-open-tabs.json", JSON.stringify(urls), { mode: 0o600 });
    await browser.execute({ type: "agent-browser", args: ["close"] });
  } catch {}
  await chrome.stop();
  for (const c of children) c.kill("SIGTERM");
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    headers(res);
    if (url.pathname === "/health") {
      json(res, connected && !stopping ? 200 : 503, {
        ok: connected && !stopping,
        browserReady: connected && !stopping,
        recovering: !connected && !stopping,
        backend: "sandbox",
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/agent/execute") {
      if (
        !config.commandKey ||
        !same(req.headers.authorization || "", `Bearer ${config.commandKey}`)
      ) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      const command = browserCommand.parse(await body(req));
      const deadline = Date.now() + 45000;
      while ((busy || !connected) && !stopping && Date.now() < deadline) await pause(15);
      if (stopping || busy || !connected) {
        json(res, 503, { error: "Cloud browser is busy; no action was started" });
        return;
      }
      busy = true;
      try {
        json(res, 200, { result: await browser.execute(command) });
      } finally {
        busy = false;
      }
      return;
    }
    if (url.pathname.startsWith("/control/")) {
      if (!control(req)) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/control/ticket") {
        const { origin: dashboard } = await body(req);
        if (
          dashboard !== undefined &&
          (typeof dashboard !== "string" || new URL(dashboard).origin !== dashboard)
        )
          throw new Error("Invalid dashboard origin");
        json(res, 200, { ticket: access.issue(dashboard ?? null) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/control/execute") {
        if (busy || !connected) {
          json(res, 409, { error: "Browser is busy" });
          return;
        }
        const command = browserCommand.parse(await body(req));
        busy = true;
        try {
          json(res, 200, { result: await browser.execute(command) });
        } finally {
          busy = false;
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/control/stop") {
        // The caller stops the Sandbox after this response. Chrome must finish
        // saving its profile before we acknowledge the stop.
        await shutdown();
        res.once("finish", () => process.exit(0));
        json(res, 200, { ok: true });
        return;
      }
      json(res, 404, { error: "Unknown control operation" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/session") {
      const session = access.exchange(url.searchParams.get("ticket") || "")?.session;
      if (!session) {
        json(res, 401, { error: "Desktop link expired or already used. Reopen it from eve." });
        return;
      }
      res.setHeader(
        "Set-Cookie",
        `eve-desktop=${session}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600`,
      );
      res.writeHead(303, { Location: url.searchParams.has("preview") ? "/?preview=1" : "/" });
      res.end();
      return;
    }
    if (!access.session(req.headers.cookie)) {
      json(res, 401, { error: "Open a fresh desktop link from eve." });
      return;
    }
    if (req.method !== "GET") {
      json(res, 405, { error: "Method not allowed" });
      return;
    }
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${origin.replace("https:", "wss:")}; img-src 'self' data: blob:; font-src 'self'`,
    );
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(await readFile(join(folder, "index.html")));
      return;
    }
    if (
      [
        "/assets/geist.woff2",
        "/assets/geist-mono.woff2",
        "/assets/eve-logo.svg",
        "/assets/favicon.svg",
      ].includes(url.pathname)
    ) {
      res.writeHead(200, {
        "Content-Type": url.pathname.endsWith(".svg") ? "image/svg+xml" : "font/woff2",
      });
      res.end(await readFile(join(folder, url.pathname.split("/").pop())));
      return;
    }
    if (url.pathname.startsWith("/novnc/")) {
      const file = resolve(novnc, decodeURIComponent(url.pathname.slice(7)));
      if (!file.startsWith(novnc + "/")) {
        json(res, 403, { error: "Forbidden" });
        return;
      }
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream" });
      res.end(data);
      return;
    }
    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 400, { error: error.code === "ENOENT" ? "Not found" : error.message });
  }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, origin);
  const socketCookie =
    url.pathname === "/websockify"
      ? authorizeDesktopSocket(access, {
          requestOrigin: req.headers.origin,
          desktopOrigin: origin,
          ticket: url.searchParams.get("ticket"),
          cookie: req.headers.cookie,
        })
      : null;
  if (!socketCookie) {
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const upstream = tcpConnect(5900, "127.0.0.1");
    ws.on("message", (bytes) => upstream.write(bytes));
    upstream.on("data", (bytes) => {
      if (ws.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount > 8 * 1024 * 1024) ws.close();
        else ws.send(bytes, { binary: true });
      }
    });
    upstream.on("error", () => ws.close());
    upstream.on("close", () => ws.close());
    ws.on("close", () => upstream.destroy());
    ws.on("error", () => upstream.destroy());
    const timer = setInterval(() => {
      if (!access.session(socketCookie)) ws.close(1008, "Session expired");
      else if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 20000);
    ws.on("close", () => clearInterval(timer));
  });
});
server.listen(6080, "0.0.0.0", () => console.log("eve remote desktop ready"));
setInterval(() => access.prune(), 60000).unref();
const terminate = () => void shutdown().finally(() => process.exit(0));
process.once("SIGTERM", terminate);
process.once("SIGINT", terminate);
