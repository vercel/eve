import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await mkdir(join(appRoot, "public"), { recursive: true });
await writeFile(
  join(appRoot, "public", "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>eve packages</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fff; color: #111; font-family: Geist, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(100% - 48px, 480px); text-align: center; }
      .mark { width: 32px; height: 32px; margin: 0 auto 24px; border-radius: 50%; background: #111; }
      h1 { margin: 0; font-size: 20px; font-weight: 500; letter-spacing: -0.03em; }
      p { margin: 8px 0 0; color: #666; font-size: 14px; }
      @media (prefers-color-scheme: dark) { body { background: #000; color: #ededed; } .mark { background: #ededed; } p { color: #888; } }
    </style>
  </head>
  <body><main><div class="mark" aria-hidden="true"></div><h1>eve packages</h1><p>Package artifacts for eve development.</p></main></body>
</html>
`,
);
