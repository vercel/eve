// Files the bridge serves from a sandbox. The bridge follows agent-browser's
// local stream, which only accepts local clients, and serves its latest frame
// over the sandbox's public port: the meeting bot shares `/<key>/`, and on
// the sign-in sandbox an admin drives the browser from `/<key>/sign-in`.
// The pages render with DOM APIs only. Every path starts with a key the
// sandbox rotates, because its public port has no other auth.

/** A dependency-free bridge. Node 22 and later ship the WebSocket client. */
export const BRIDGE_SERVER = `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";

const root = process.env.BRIDGE_ROOT;
const session = process.env.BRIDGE_SESSION;
const stateFile = process.env.BRIDGE_STATE_FILE;
const interactive = process.env.BRIDGE_INTERACTIVE === "1";
const pages = { "": "screen.html", "sign-in": "sign-in.html" };
const inputTypes = new Set(["input_mouse", "input_keyboard"]);

let frame = null;
let socket = null;
// Clients of the MJPEG stream. One busy with an earlier frame skips newer
// ones until it drains, so a slow viewer never builds a backlog.
const viewers = new Set();

// Recall shares pages at 15 frames a second at most; more only costs bandwidth.
const FRAME_MS = 1000 / 15;

function send(viewer) {
  if (frame === null || viewer.busy || viewer.timer) return;
  const wait = viewer.sentAt + FRAME_MS - Date.now();
  if (wait > 0) {
    viewer.timer = setTimeout(() => { viewer.timer = null; send(viewer); }, wait);
    return;
  }
  viewer.sentAt = Date.now();
  const ready = viewer.response.write(
    "--frame\\r\\nContent-Type: image/jpeg\\r\\nContent-Length: " + frame.length + "\\r\\n\\r\\n",
  ) && viewer.response.write(frame) && viewer.response.write("\\r\\n");
  if (!ready) {
    viewer.busy = true;
    viewer.response.once("drain", () => { viewer.busy = false; send(viewer); });
  }
}

// A page that doesn't change sends no frames, so resend the latest one: the
// viewer can then tell a quiet page from a dead connection.
setInterval(() => { for (const viewer of viewers) send(viewer); }, 3000);

function connect() {
  const ws = new WebSocket("ws://127.0.0.1:" + process.env.AGENT_BROWSER_STREAM_PORT);
  ws.onopen = () => {
    socket = ws;
    ws.send(JSON.stringify({ type: "config", maxFps: 15 }));
  };
  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type !== "frame") return;
      frame = Buffer.from(message.data, "base64");
      for (const viewer of viewers) send(viewer);
    } catch {}
  };
  ws.onerror = () => ws.close();
  ws.onclose = () => {
    if (socket === ws) socket = null;
    setTimeout(connect, 1000);
  };
}
connect();

function key() {
  try { return readFileSync(root + "/key", "utf8").trim(); } catch { return ""; }
}

function agentBrowser(args) {
  return new Promise((resolve, reject) =>
    execFile("agent-browser", ["--session", session, ...args], { timeout: 60_000 }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr || error.message)) : resolve(stdout),
    ),
  );
}

async function body(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 8192) throw new Error("too large");
  }
  return JSON.parse(text || "{}");
}

const headers = { "cache-control": "no-store" };

createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://bridge").pathname;
  if (path === "/healthz") return response.end(process.env.BRIDGE_VERSION ?? "");
  const current = key();
  const match = /^\\/([0-9a-f]{36})\\/(.*)$/.exec(path);
  if (!current || !match || match[1] !== current) return response.writeHead(404).end();
  const name = match[2];
  try {
    if (request.method === "GET" && name in pages && (name === "" || interactive)) {
      const html = readFileSync(root + "/" + pages[name]);
      return response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" }).end(html);
    }
    if (request.method === "GET" && name === "stream.mjpg") {
      response.writeHead(200, {
        ...headers,
        "content-type": "multipart/x-mixed-replace; boundary=frame",
        "x-accel-buffering": "no",
      });
      const viewer = { response, busy: false, sentAt: 0, timer: null };
      viewers.add(viewer);
      request.on("close", () => {
        viewers.delete(viewer);
        clearTimeout(viewer.timer);
      });
      return send(viewer);
    }
    if (request.method === "GET" && name === "frame.jpg") {
      if (frame === null) return response.writeHead(503, headers).end();
      return response.writeHead(200, { ...headers, "content-type": "image/jpeg" }).end(frame);
    }
    if (request.method === "POST" && interactive) {
      const input = await body(request);
      if (name === "input" && inputTypes.has(input.type)) {
        socket?.send(JSON.stringify(input));
        return response.writeHead(204).end();
      }
      if (name === "open" && /^https?:\\/\\//.test(String(input.url))) {
        await agentBrowser(["open", String(input.url)]);
        return response.writeHead(204).end();
      }
      if (name === "save") {
        await agentBrowser(["state", "save", stateFile]);
        return response.writeHead(204).end();
      }
    }
    response.writeHead(404).end();
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain" }).end(String(error.message ?? error));
  }
}).listen(Number(process.env.BRIDGE_PORT), "0.0.0.0");
`;

/** What the meeting sees: the browser's latest frame, swapped in as each one loads. */
export const SCREEN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>eve</title>
<style>
  html, body { margin: 0; width: 100vw; height: 100vh; overflow: hidden; background: #000; }
  img { width: 100%; height: 100%; object-fit: contain; display: block; }
</style>
</head>
<body>
<img id="screen" alt="">
<script>
  // Reads the MJPEG stream with fetch rather than an <img>, which freezes
  // without an error when a proxy closes the connection. Reconnects when the
  // stream ends or goes quiet; the bridge resends a frame every few seconds.
  function watch(show) {
    let controller;
    let timer;
    const restart = () => { controller?.abort(); clearTimeout(timer); setTimeout(connect, 500); };
    const stall = () => { clearTimeout(timer); timer = setTimeout(restart, 10000); };
    async function connect() {
      controller = new AbortController();
      stall();
      try {
        const response = await fetch("stream.mjpg?t=" + Date.now(), { signal: controller.signal, cache: "no-store" });
        const reader = response.body.getReader();
        let buffer = new Uint8Array(0);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const joined = new Uint8Array(buffer.length + value.length);
          joined.set(buffer);
          joined.set(value, buffer.length);
          buffer = joined;
          for (;;) {
            const text = new TextDecoder().decode(buffer.subarray(0, Math.min(buffer.length, 200)));
            const header = /Content-Length: (\\d+)\\r\\n\\r\\n/.exec(text);
            if (header === null) break;
            const start = header.index + header[0].length;
            const end = start + Number(header[1]);
            if (buffer.length < end) break;
            show(new Blob([buffer.slice(start, end)], { type: "image/jpeg" }));
            stall();
            buffer = buffer.slice(end);
          }
        }
      } catch {}
      restart();
    }
    connect();
  }
  function showOn(element) {
    let previous;
    return (blob) => {
      const url = URL.createObjectURL(blob);
      element.src = url;
      if (previous) URL.revokeObjectURL(previous);
      previous = url;
    };
  }
  watch(showOn(document.getElementById("screen")));
</script>
</body>
</html>
`;

/** The sign-in page: a live view of the browser that forwards clicks and keys, and saves the result. */
export const SIGN_IN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>eve browser sign-ins</title>
<style>
  :root { color-scheme: dark; font: 14px system-ui, sans-serif; }
  body { margin: 0; background: #0a0a0a; color: #ededed; }
  header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 16px; border-bottom: 1px solid #262626; }
  button, input { font: inherit; color: inherit; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 6px 10px; }
  button:hover { background: #262626; }
  #save { background: #0070f3; border-color: #0070f3; }
  #url { flex: 1; min-width: 240px; }
  #status { color: #a1a1a1; }
  main { padding: 16px; }
  #screen { display: block; width: 100%; max-width: 1280px; aspect-ratio: 16 / 9; object-fit: contain; background: #000; outline: none; cursor: default; }
  #screen:focus { box-shadow: 0 0 0 2px #0070f3; }
  p { color: #a1a1a1; max-width: 1280px; }
</style>
</head>
<body>
<header>
  <button data-url="https://www.notion.so/login">Notion</button>
  <button data-url="https://accounts.google.com/">Google</button>
  <button data-url="https://github.com/login">GitHub</button>
  <button data-url="https://linear.app/login">Linear</button>
  <button data-url="https://www.figma.com/login">Figma</button>
  <form id="go"><input id="url" placeholder="Or any https:// sign-in page"></form>
  <button id="save">Save sign-ins</button>
  <span id="status"></span>
</header>
<main>
  <img id="screen" tabindex="0" alt="eve's browser">
  <p>Sign in with the service accounts eve should use in meetings, then save. Click the browser view before typing. Saved sign-ins apply to meetings that start afterward.</p>
</main>
<script>
  const screen = document.getElementById("screen");
  const status = document.getElementById("status");
  // Reads the MJPEG stream with fetch rather than an <img>, which freezes
  // without an error when a proxy closes the connection. Reconnects when the
  // stream ends or goes quiet; the bridge resends a frame every few seconds.
  function watch(show) {
    let controller;
    let timer;
    const restart = () => { controller?.abort(); clearTimeout(timer); setTimeout(connect, 500); };
    const stall = () => { clearTimeout(timer); timer = setTimeout(restart, 10000); };
    async function connect() {
      controller = new AbortController();
      stall();
      try {
        const response = await fetch("stream.mjpg?t=" + Date.now(), { signal: controller.signal, cache: "no-store" });
        const reader = response.body.getReader();
        let buffer = new Uint8Array(0);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const joined = new Uint8Array(buffer.length + value.length);
          joined.set(buffer);
          joined.set(value, buffer.length);
          buffer = joined;
          for (;;) {
            const text = new TextDecoder().decode(buffer.subarray(0, Math.min(buffer.length, 200)));
            const header = /Content-Length: (\\d+)\\r\\n\\r\\n/.exec(text);
            if (header === null) break;
            const start = header.index + header[0].length;
            const end = start + Number(header[1]);
            if (buffer.length < end) break;
            show(new Blob([buffer.slice(start, end)], { type: "image/jpeg" }));
            stall();
            buffer = buffer.slice(end);
          }
        }
      } catch {}
      restart();
    }
    connect();
  }
  function showOn(element) {
    let previous;
    return (blob) => {
      const url = URL.createObjectURL(blob);
      element.src = url;
      if (previous) URL.revokeObjectURL(previous);
      previous = url;
    };
  }
  watch(showOn(screen));

  function post(name, value) {
    return fetch(name, { method: "POST", body: JSON.stringify(value) }).then((response) => {
      if (!response.ok) return response.text().then((text) => { throw new Error(text || response.status); });
    });
  }
  function report(promise, done) {
    status.textContent = "…";
    promise.then(() => { status.textContent = done; }, (error) => { status.textContent = "Failed: " + error.message; });
  }
  function open(url) { report(post("open", { url }), ""); }

  for (const button of document.querySelectorAll("button[data-url]")) {
    button.onclick = () => open(button.dataset.url);
  }
  document.getElementById("go").onsubmit = (event) => {
    event.preventDefault();
    open(document.getElementById("url").value.trim());
  };
  document.getElementById("save").onclick = () => report(post("save", {}), "Saved.");

  function point(event) {
    const box = screen.getBoundingClientRect();
    const width = screen.naturalWidth || 1280;
    const height = screen.naturalHeight || 720;
    // object-fit: contain letterboxes the frame inside the element.
    const scale = Math.min(box.width / width, box.height / height);
    const left = (box.width - width * scale) / 2;
    const top = (box.height - height * scale) / 2;
    return {
      x: Math.round((event.clientX - box.left - left) / scale),
      y: Math.round((event.clientY - box.top - top) / scale),
    };
  }
  const buttons = ["left", "middle", "right"];
  screen.onmousedown = (event) => {
    screen.focus();
    event.preventDefault();
    post("input", { type: "input_mouse", eventType: "mousePressed", ...point(event), button: buttons[event.button] ?? "left", clickCount: event.detail || 1 });
  };
  screen.onmouseup = (event) => post("input", { type: "input_mouse", eventType: "mouseReleased", ...point(event), button: buttons[event.button] ?? "left" });
  screen.onwheel = (event) => {
    event.preventDefault();
    post("input", { type: "input_mouse", eventType: "mouseWheel", ...point(event), deltaX: event.deltaX, deltaY: event.deltaY });
  };
  screen.oncontextmenu = (event) => event.preventDefault();

  function modifiers(event) {
    return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
  }
  screen.onkeydown = (event) => {
    event.preventDefault();
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      post("input", { type: "input_keyboard", eventType: "char", text: event.key });
      return;
    }
    post("input", { type: "input_keyboard", eventType: "keyDown", key: event.key, code: event.code, modifiers: modifiers(event) });
  };
  screen.onkeyup = (event) => {
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
    post("input", { type: "input_keyboard", eventType: "keyUp", key: event.key, code: event.code, modifiers: modifiers(event) });
  };
  // Pasting types the text, such as a one-time code.
  document.addEventListener("paste", (event) => {
    if (document.activeElement !== screen) return;
    event.preventDefault();
    for (const char of event.clipboardData.getData("text")) {
      post("input", { type: "input_keyboard", eventType: "char", text: char });
    }
  });
</script>
</body>
</html>
`;
