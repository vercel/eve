// Files the desktop stage serves from the sandbox. The meeting bot's browser
// loads `index.html`, which keeps swapping in the latest `screen.jpg`.

/** A dependency-free static server for `/<token>/<file>`, and `/healthz`. */
export const STAGE_SERVER = `import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.STAGE_ROOT;
const types = { html: "text/html; charset=utf-8", jpg: "image/jpeg" };

createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://stage").pathname;
  if (path === "/healthz") return response.end("ok");
  // Plain file names only, so a path can't leave the token's directory.
  const match = /^\\/([0-9a-f]{36})\\/(?:([a-z]+)\\.(html|jpg))?$/.exec(path);
  if (!match) return response.writeHead(404).end();
  const [, token, name = "index", ext = "html"] = match;
  try {
    const body = await readFile(join(root, token, name + "." + ext));
    response.writeHead(200, { "content-type": types[ext], "cache-control": "no-store" }).end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(Number(process.env.STAGE_PORT), "0.0.0.0");
`;

export const STAGE_HTML = `<!doctype html>
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
  // Load each frame off screen and swap it in, so a frame ffmpeg is still
  // writing never shows.
  function next() {
    const image = new Image();
    image.onload = () => { screen.replaceWith(image); screen = image; setTimeout(next, 200); };
    image.onerror = () => setTimeout(next, 500);
    image.src = "screen.jpg?frame=" + frame++;
  }
  next();
</script>
</body>
</html>
`;
