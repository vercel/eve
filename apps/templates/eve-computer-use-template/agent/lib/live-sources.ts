/**
 * Scripts the live view runs inside the sandbox. Both are plain Node with no dependencies, and
 * written without template interpolation so they embed verbatim.
 */

/**
 * The relay on the sandbox's one public port. Only the web app's /api/live route connects to it,
 * with a token it reads from the sandbox; browsers never see the token or this address. It
 * checks the token, then forwards the WebSocket to a local stream without an Origin, which
 * agent-browser rejects unless it is loopback:
 *
 * - `/browser?token=`: agent-browser's stream for the browser session.
 * - `/desktop?token=`: the desktop stream below.
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
const upstreams = { "/browser": Number(BROWSER_PORT), "/desktop": Number(DESKTOP_PORT) };
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
  const port = upstreams[url.pathname];
  if (port === undefined || !authorized(url)) {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  url.searchParams.delete("token");
  const upstream = net.connect(port, "127.0.0.1", () => {
    const headers = Object.entries(req.headers).filter(([key]) => key !== "origin" && key !== "host");
    upstream.write("GET /" + url.search + " HTTP/1.1\r\nhost: 127.0.0.1:" + port + "\r\n" + headers.map(([k, v]) => k + ": " + v).join("\r\n") + "\r\n\r\n");
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

/**
 * The desktop's live view, in the same WebSocket protocol as agent-browser's stream, so one
 * client works for both: JSON `frame` messages with base64 JPEGs out, `input_mouse` and
 * `input_keyboard` messages in. Frames come from ffmpeg's x11grab only while someone watches,
 * and input goes to the display through xdotool.
 *
 * Arguments: <port> <display>.
 */
export const DESKTOP_STREAM_SOURCE = String.raw`
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn, execFile, execFileSync } = require("node:child_process");

const [, , PORT, DISPLAY] = process.argv;
const env = { ...process.env, DISPLAY };
const clients = new Set();
let ffmpeg = null;

function frame(text) {
  const payload = Buffer.from(text);
  const length = payload.length;
  let header;
  if (length < 126) header = Buffer.from([0x81, length]);
  else if (length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2); }
  return Buffer.concat([header, payload]);
}

function broadcast(message) {
  const bytes = frame(JSON.stringify(message));
  for (const client of clients) if (client.writable) client.write(bytes);
}

// The agent can resize the desktop, so read its size each time capture starts.
function screenSize() {
  try {
    const match = /dimensions:\s+(\d+)x(\d+)/.exec(execFileSync("xdpyinfo", [], { env }).toString());
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  } catch {}
  return { width: 1920, height: 1080 };
}

function startCapture(fps) {
  if (ffmpeg) return;
  const { width, height } = screenSize();
  ffmpeg = spawn("ffmpeg", [
    "-loglevel", "error",
    "-f", "x11grab", "-draw_mouse", "1", "-framerate", String(fps), "-video_size", width + "x" + height, "-i", DISPLAY,
    "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "6", "-",
  ]);
  let buffer = Buffer.alloc(0);
  ffmpeg.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    // Split the MJPEG stream on JPEG end markers.
    for (;;) {
      const end = buffer.indexOf(Buffer.from([0xff, 0xd9]));
      if (end < 0) break;
      const jpeg = buffer.subarray(0, end + 2);
      buffer = buffer.subarray(end + 2);
      const start = jpeg.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) continue;
      broadcast({
        type: "frame",
        data: jpeg.subarray(start).toString("base64"),
        metadata: { deviceWidth: width, deviceHeight: height, timestamp: Date.now() },
      });
    }
  });
  ffmpeg.on("exit", () => { ffmpeg = null; });
}

function stopCapture() {
  if (ffmpeg && clients.size === 0) ffmpeg.kill();
}

const xdotool = (...args) => execFile("xdotool", args, { env }, () => {});

const BUTTONS = { left: "1", middle: "2", right: "3" };
const KEYS = {
  Enter: "Return", Backspace: "BackSpace", Tab: "Tab", Escape: "Escape", Delete: "Delete", " ": "space",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Home: "Home", End: "End",
  PageUp: "Prior", PageDown: "Next", Shift: "Shift_L", Control: "Control_L", Alt: "Alt_L", Meta: "Super_L",
};

function input(message) {
  if (message.type === "input_mouse") {
    const x = String(Math.round(message.x));
    const y = String(Math.round(message.y));
    if (message.eventType === "mouseMoved") xdotool("mousemove", x, y);
    else if (message.eventType === "mousePressed") xdotool("mousemove", x, y, "mousedown", BUTTONS[message.button] || "1");
    else if (message.eventType === "mouseReleased") xdotool("mousemove", x, y, "mouseup", BUTTONS[message.button] || "1");
    else if (message.eventType === "mouseWheel") {
      const button = (message.deltaY || 0) > 0 ? "5" : (message.deltaY || 0) < 0 ? "4" : (message.deltaX || 0) > 0 ? "7" : "6";
      xdotool("mousemove", x, y, "click", button);
    }
    return;
  }
  if (message.type === "input_keyboard") {
    const modifiers = message.modifiers || 0;
    // Printable text without Ctrl or Meta types as text; everything else is a key event.
    if (message.eventType === "keyDown" && message.text && message.text !== "\r" && !(modifiers & 6)) {
      xdotool("type", "--delay", "0", "--", message.text);
      return;
    }
    const key = KEYS[message.key] || (message.key && message.key.length === 1 ? message.key : null);
    if (!key) return;
    xdotool(message.eventType === "keyDown" ? "keydown" : "keyup", key);
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(req.url === "/health" ? 200 : 404);
  res.end();
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, "http://stream");
  const fps = Math.min(Math.max(Number(url.searchParams.get("maxFps")) || 10, 1), 20);
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  clients.add(socket);
  startCapture(fps);

  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const maskAt = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = buffer.subarray(maskAt, maskAt + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) { socket.end(); return; }
      if (opcode !== 0x1) continue;
      try { input(JSON.parse(payload.toString("utf8"))); } catch {}
    }
  });
  const drop = () => { clients.delete(socket); stopCapture(); };
  socket.on("close", drop);
  socket.on("error", drop);
});

server.listen(Number(PORT), "127.0.0.1");
`;
