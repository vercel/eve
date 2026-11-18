/**
 * The relay on the sandbox's one public port. Only the web app's /api/live route connects to it,
 * with a token it reads from the sandbox; browsers never see the token or this address. It
 * checks the token, then forwards the WebSocket to a local stream without an Origin, which
 * agent-browser rejects unless it is loopback. It is plain Node with no dependencies, written
 * without template interpolation so it embeds verbatim:
 *
 * - `/browser?token=`: agent-browser's stream for the browser session.
 * - `/desktop?token=`: screen-relay's `/stream` for the desktop, H.264 in its `nsl1` protocol.
 *   screen-relay listens on another loopback address so it requires a token of its own, which
 *   the relay reads from screen-relay's token file and offers as the `bearer.<token>` WebSocket
 *   subprotocol, as screen-relay's own viewer does; a page open in the sandbox's browsers can't
 *   reach the desktop without it.
 * - `POST /browser/navigate?token=&action=back|forward|reload`: the browser's history buttons,
 *   which agent-browser's stream has no message for.
 * - `POST /browser/open?token=&url=`: the address bar. Only http(s) URLs are opened.
 *
 * Arguments: <public port> <browser stream port> <desktop stream host> <desktop stream port>
 * <desktop token file> <token file> <version> <browser session>.
 */
export const RELAY_SOURCE = String.raw`
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const [, , PUBLIC_PORT, BROWSER_PORT, DESKTOP_HOST, DESKTOP_PORT, DESKTOP_TOKEN_FILE, TOKEN_FILE, VERSION, BROWSER_SESSION] = process.argv;
const token = crypto.randomBytes(24).toString("hex");
// screen-relay rotates its token each time it starts, so it is read per connection.
const desktopToken = () => fs.readFileSync(DESKTOP_TOKEN_FILE, "utf8").trim();
const upstreams = {
  "/browser": { host: "127.0.0.1", port: Number(BROWSER_PORT), path: "/" },
  "/desktop": { host: DESKTOP_HOST, port: Number(DESKTOP_PORT), path: "/stream", token: desktopToken },
};

function parse(req) {
  try {
    return new URL(req.url, "http://relay");
  } catch {
    return null;
  }
}
const NAVIGATION = new Set(["back", "forward", "reload"]);

function authorized(url) {
  const given = Buffer.from(url.searchParams.get("token") || "");
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const server = http.createServer((req, res) => {
  const url = parse(req);
  if (url === null) { res.writeHead(400); res.end(); return; }
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
  socket.on("error", () => socket.destroy());
  const url = parse(req);
  const target = url === null ? undefined : upstreams[url.pathname];
  if (target === undefined || !authorized(url)) {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  let bearer = null;
  try {
    if (target.token) bearer = "bearer." + target.token();
  } catch {
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    return;
  }
  url.searchParams.delete("token");
  const upstream = net.connect(target.port, target.host, () => {
    const headers = Object.entries(req.headers)
      .filter(([key]) => key !== "origin" && key !== "host" && key !== "authorization")
      .map(([key, value]) => (bearer !== null && key === "sec-websocket-protocol" ? [key, value + ", " + bearer] : [key, value]));
    // screen-relay only answers a loopback Host, whichever loopback address it listens on.
    upstream.write("GET " + target.path + url.search + " HTTP/1.1\r\nhost: 127.0.0.1:" + target.port + "\r\n" + headers.map(([k, v]) => k + ": " + v).join("\r\n") + "\r\n\r\n");
    upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.on("clientError", (error, socket) => socket.destroy());

server.listen(Number(PUBLIC_PORT), "0.0.0.0", () => {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, version: VERSION }), { mode: 0o600 });
});
`;
