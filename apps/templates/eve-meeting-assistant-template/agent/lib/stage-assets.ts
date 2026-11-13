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

function connect() {
  const ws = new WebSocket("ws://127.0.0.1:" + process.env.AGENT_BROWSER_STREAM_PORT + "/?maxFps=8");
  ws.onopen = () => { socket = ws; };
  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "frame") frame = Buffer.from(message.data, "base64");
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
  if (path === "/healthz") return response.end("ok");
  const current = key();
  const match = /^\\/([0-9a-f]{36})\\/(.*)$/.exec(path);
  if (!current || !match || match[1] !== current) return response.writeHead(404).end();
  const name = match[2];
  try {
    if (request.method === "GET" && name in pages && (name === "" || interactive)) {
      const html = readFileSync(root + "/" + pages[name]);
      return response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" }).end(html);
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
  let screen = document.getElementById("screen");
  let frame = 0;
  function next() {
    const image = new Image();
    image.onload = () => { screen.replaceWith(image); screen = image; setTimeout(next, 125); };
    image.onerror = () => setTimeout(next, 500);
    image.src = "frame.jpg?n=" + frame++;
  }
  next();
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
  let screen = document.getElementById("screen");
  const status = document.getElementById("status");
  let frame = 0;
  function next() {
    const image = new Image();
    image.onload = () => {
      screen.src = image.src;
      setTimeout(next, 125);
    };
    image.onerror = () => setTimeout(next, 500);
    image.src = "frame.jpg?n=" + frame++;
  }
  next();

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
