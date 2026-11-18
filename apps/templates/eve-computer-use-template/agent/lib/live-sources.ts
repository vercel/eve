/**
 * The relay on the sandbox's one public port. Only the web app's /api/live route connects to it,
 * with a token it reads from the sandbox; browsers never see the token or this address. It
 * checks the token, then forwards the WebSocket to a local stream without an Origin, which
 * agent-browser and screen-relay reject unless it is loopback. It is plain Node with no
 * dependencies, written without template interpolation so it embeds verbatim:
 *
 * - `/browser?token=`: agent-browser's stream for the browser session.
 * - `/desktop?token=`: screen-relay's `/stream` for the desktop, H.264 in its `nsl1` protocol.
 * - `POST /browser/navigate?token=&action=back|forward|reload`: the browser's history buttons,
 *   which agent-browser's stream has no message for.
 * - `POST /browser/open?token=&url=`: the address bar. Only http(s) URLs are opened.
 *
 * Arguments: <public port> <browser stream port> <desktop stream port> <token file> <version>
 * <browser session>.
 */
export const RELAY_SOURCE = String.raw`
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const [, , PUBLIC_PORT, BROWSER_PORT, DESKTOP_PORT, TOKEN_FILE, VERSION, BROWSER_SESSION] = process.argv;
const token = crypto.randomBytes(24).toString("hex");
const upstreams = {
  "/browser": { port: Number(BROWSER_PORT), path: "/" },
  "/desktop": { port: Number(DESKTOP_PORT), path: "/stream" },
};
const NAVIGATION = new Set(["back", "forward", "reload"]);

function authorized(url) {
  const given = Buffer.from(url.searchParams.get("token") || "");
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://relay");
  if (url.pathname === "/health") { res.writeHead(200); res.end(); return; }
  if (req.method === "POST" && url.pathname === "/browser/navigate") {
    const action = url.searchParams.get("action");
    if (!authorized(url) || !NAVIGATION.has(action)) { res.writeHead(403); res.end(); return; }
    execFile("agent-browser", ["--session", BROWSER_SESSION, action], { timeout: 30000 }, (error) => {
      res.writeHead(error ? 502 : 204);
      res.end();
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/browser/open") {
    let target = null;
    try { target = new URL(url.searchParams.get("url") || ""); } catch {}
    if (!authorized(url) || target === null || (target.protocol !== "http:" && target.protocol !== "https:")) {
      res.writeHead(403); res.end(); return;
    }
    // execFile passes the URL as one argument, never through a shell.
    execFile("agent-browser", ["--session", BROWSER_SESSION, "open", target.href], { timeout: 60000 }, (error) => {
      res.writeHead(error ? 502 : 204);
      res.end();
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://relay");
  const target = upstreams[url.pathname];
  if (target === undefined || !authorized(url)) {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  url.searchParams.delete("token");
  const upstream = net.connect(target.port, "127.0.0.1", () => {
    const headers = Object.entries(req.headers).filter(([key]) => key !== "origin" && key !== "host");
    upstream.write("GET " + target.path + url.search + " HTTP/1.1\r\nhost: 127.0.0.1:" + target.port + "\r\n" + headers.map(([k, v]) => k + ": " + v).join("\r\n") + "\r\n\r\n");
    upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(Number(PUBLIC_PORT), "0.0.0.0", () => {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, version: VERSION }), { mode: 0o600 });
});
`;
