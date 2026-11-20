// @ts-check
/**
 * The browser's live view relay, on a public sandbox port. Only the web app's /api/live route
 * connects to it, with a token it reads from the sandbox; browsers never see the token or this
 * address. It checks the token, then forwards the WebSocket to agent-browser's stream without an
 * Origin, which agent-browser rejects unless it is loopback. agent/lib/live.ts writes this file
 * into the sandbox and runs it with Node, so it uses only Node's own modules:
 *
 * - `/browser?token=`: agent-browser's stream for the browser session.
 * - `POST /browser/navigate?token=&action=back|forward|reload`: the browser's history buttons,
 *   which agent-browser's stream has no message for.
 * - `POST /browser/open?token=&url=`: the address bar. Only http(s) URLs are opened.
 *
 * Usage: node live-relay.cjs <public port> <browser stream port> <token file> <version> <browser session>
 */
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const NAVIGATION = new Set(["back", "forward", "reload"]);

/**
 * @param {{ token: string, browserPort: number, browserSession: string, run?: typeof execFile }} options
 */
function createRelay({ token, browserPort, browserSession, run = execFile }) {
  /** @param {URL} url */
  const authorized = (url) => {
    const given = Buffer.from(url.searchParams.get("token") || "");
    const expected = Buffer.from(token);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  };
  /** @param {string[]} args @param {number} timeout @param {http.ServerResponse} res */
  const agentBrowser = (args, timeout, res) =>
    run("agent-browser", ["--session", browserSession, ...args], { timeout }, (error) => {
      res.writeHead(error ? 502 : 204);
      res.end();
    });

  const server = http.createServer((req, res) => {
    const url = parse(req.url);
    if (url === null) return reply(res, 400);
    if (url.pathname === "/health") return reply(res, 200);
    if (req.method === "POST" && url.pathname === "/browser/navigate") {
      const action = url.searchParams.get("action") || "";
      if (!authorized(url) || !NAVIGATION.has(action)) return reply(res, 403);
      return agentBrowser([action], 30_000, res);
    }
    if (req.method === "POST" && url.pathname === "/browser/open") {
      const target = httpUrl(url.searchParams.get("url"));
      if (!authorized(url) || target === null) return reply(res, 403);
      // execFile passes the URL as one argument, never through a shell.
      return agentBrowser(["open", target], 60_000, res);
    }
    reply(res, 404);
  });

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    const url = parse(req.url);
    if (url === null || url.pathname !== "/browser" || !authorized(url)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    url.searchParams.delete("token");
    const upstream = net.connect(browserPort, "127.0.0.1", () => {
      const headers = Object.entries(req.headers).filter(
        ([key]) => key !== "origin" && key !== "host" && key !== "authorization",
      );
      const lines = headers.map(([key, value]) => `${key}: ${value}`).join("\r\n");
      upstream.write(
        `GET /${url.search} HTTP/1.1\r\nhost: 127.0.0.1:${browserPort}\r\n${lines}\r\n\r\n`,
      );
      upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    // Frames out and input in are small and latency-bound; don't hold them for coalescing.
    upstream.setNoDelay(true);
    if (socket instanceof net.Socket) socket.setNoDelay(true);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  server.on("clientError", (_error, socket) => socket.destroy());
  return server;
}

/** @param {string | undefined} target */
function parse(target) {
  try {
    return new URL(target ?? "", "http://relay");
  } catch {
    return null;
  }
}

/** The URL as an http(s) URL to open, or null for anything else. @param {string | null} value */
function httpUrl(value) {
  try {
    const url = new URL(value || "");
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** @param {http.ServerResponse} res @param {number} status */
function reply(res, status) {
  res.writeHead(status);
  res.end();
}

if (require.main === module) {
  const [publicPort, browserPort, tokenFile, version, browserSession] = process.argv.slice(2);
  const token = crypto.randomBytes(24).toString("hex");
  createRelay({ token, browserPort: Number(browserPort), browserSession }).listen(
    Number(publicPort),
    "0.0.0.0",
    () => fs.writeFileSync(tokenFile, JSON.stringify({ token, version }), { mode: 0o600 }),
  );
}

module.exports = { createRelay };
