import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Locator, Page } from "playwright-core";

import type {
  ClientDriver,
  RenderedOption,
  ShownText,
} from "#internal/testing/channel-conformance/harness.js";

/** The Web Chat template `eve integration setup web` installs, as the docs registry ships it. */
const TEMPLATE_ROOT = fileURLToPath(
  new URL("../../../../../../apps/docs/registry/channel/web/", import.meta.url),
);
/** The registry item that lists the template's dependencies, as `eve integration setup web` installs them. */
const REGISTRY_PATH = fileURLToPath(
  new URL("../../../../../../apps/docs/registry.json", import.meta.url),
);
/** Outside the workspace, so the template's pins never touch the workspace lockfile. */
const INSTALL_ROOT = join(tmpdir(), "eve-web-chat-template");
const EVE_SOURCE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const ENTRY_ID = "virtual:web-chat-entry";
// Mounts the template's chat the way its `app/page.tsx` does, without Next's server.
const ENTRY_SOURCE = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { AgentChat } from "@/app/_components/agent-chat";
import "@/app/globals.css";
createRoot(document.getElementById("root")).render(createElement(AgentChat));
`;
const PAGE_HTML =
  '<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';

const COMPOSER_PLACEHOLDER = "Send a message…";

let bundled: Promise<string> | undefined;

/**
 * Drives the Web Chat template's real React page in headless Chromium. The
 * page is the registry's `AgentChat` bundled with Vite and served from a local
 * origin that forwards every other request to the agent, so the browser's
 * `useEveAgent` talks to `eveChannel` exactly as it does behind `withEve()`.
 * It reads only the DOM and acts only through clicks and keys.
 */
export function webChatDriver(): ClientDriver {
  return {
    name: "web chat",
    capabilities: ["buttons", "text-replies"],
    // A browser tab shows only the person using it.
    surface: "private",
    async open(host, wait) {
      const assets = await (bundled ??= bundleTemplate());
      const server = await servePage(host, assets);
      const { chromium } = await import("playwright-core");
      const browser = await chromium.launch();
      const close = async () => {
        await browser.close();
        await server.close();
      };
      const page = await browser.newPage();
      // A card can re-render between reading a button and using it; fail fast and read again.
      page.setDefaultTimeout(2_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => void errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      let seen = "";
      const look = async () => {
        seen = await page
          .locator("body")
          .innerText({ timeout: 1_000 })
          .catch(() => seen);
      };
      const describe = () => `Page errors: ${JSON.stringify(errors)}\nPage text:\n${seen}`;
      const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);

      try {
        await page.goto(server.url);
        await wait(
          "the composer",
          async () => {
            await look();
            return (await composer.isEditable()) ? true : undefined;
          },
          describe,
        );
      } catch (error) {
        await close();
        throw error;
      }

      return {
        async say(text) {
          await composer.fill(text);
          await composer.press("Enter");
        },
        waitForQuestion: (prompts) =>
          wait(
            `one of the questions ${JSON.stringify(prompts)}`,
            async () => {
              await look();
              for (const prompt of prompts) {
                const options = await promptOptions(page, prompt).catch(() => undefined);
                if (options !== undefined) return { options, prompt };
              }
              return undefined;
            },
            describe,
          ),
        async press(option) {
          const button = option.handle as Locator;
          // An answered prompt disables its buttons, and clicking one does nothing.
          if ((await button.count()) > 0 && (await button.isEnabled())) await button.click();
        },
        async replies() {
          await look();
          // Each assistant text part renders as its own Streamdown block.
          return await page.locator(".is-assistant .size-full").allInnerTexts();
        },
        async shownPrompt(prompt) {
          await look();
          return {
            id: prompt,
            options: (await promptOptions(page, prompt)) ?? [],
            text: seen,
          };
        },
        async shown() {
          await look();
          const shown: ShownText[] = [];
          for (const message of await page.locator(".is-assistant").all()) {
            const links: string[] = [];
            for (const anchor of await message.locator("a[href]").all()) {
              links.push((await anchor.getAttribute("href"))!);
            }
            const text = [await message.innerText(), ...links].join("\n");
            const options = (await readButtons(message.getByRole("button"))) ?? [];
            shown.push({ onlyPerson: true, options, text });
          }
          return shown;
        },
        describe,
        close,
      };
    },
  };
}

/** The choices a question or approval titled `prompt` offers now, if it's open. */
async function promptOptions(page: Page, prompt: string): Promise<RenderedOption[] | undefined> {
  return (
    (await questionOptions(page, prompt)) ??
    (await approvalOptions(page, prompt)) ??
    (await openEndedQuestion(page, prompt))
  );
}

/** An open-ended `ask_question` card: the prompt above a text field while it's open. */
async function openEndedQuestion(page: Page, prompt: string): Promise<[] | undefined> {
  const label = page.locator("p").getByText(prompt, { exact: true }).last();
  if ((await label.count()) === 0) return undefined;
  const field = label.locator("xpath=..").getByRole("textbox", { name: "Answer" });
  return (await field.count()) > 0 && (await field.isEditable()) ? [] : undefined;
}

/** An `ask_question` card: one radio per option while the question is open. */
async function questionOptions(page: Page, prompt: string): Promise<RenderedOption[] | undefined> {
  const group = page.getByRole("radiogroup", { exact: true, name: prompt }).last();
  if ((await group.count()) === 0) return undefined;
  return await readButtons(group.getByRole("radio"));
}

/** A tool approval: the prompt above one button per choice until it's answered. */
async function approvalOptions(page: Page, prompt: string): Promise<RenderedOption[] | undefined> {
  const label = page.locator("p").getByText(prompt, { exact: true }).last();
  if ((await label.count()) === 0) return undefined;
  return await readButtons(label.locator("xpath=..").getByRole("button"));
}

/** The buttons a person can press now, labelled by their first line of text. */
async function readButtons(buttons: Locator): Promise<RenderedOption[] | undefined> {
  const all = await buttons.all();
  if (all.length === 0) return undefined;
  const options: RenderedOption[] = [];
  for (const button of all) {
    if (!(await button.isEnabled())) return undefined;
    const label = (await button.innerText()).split("\n")[0]!.trim();
    options.push({ handle: button, label });
  }
  return options;
}

/**
 * Copies the template into a fresh app root beside the dependencies its
 * registry item lists, the way `eve integration setup web` lays out an app.
 */
async function installTemplate(): Promise<string> {
  const registry = JSON.parse(await readFile(REGISTRY_PATH, "utf8")) as {
    items: { name: string; dependencies?: string[] }[];
  };
  const item = registry.items.find(({ name }) => name === "channel/web");
  if (item?.dependencies === undefined) {
    throw new Error(`${REGISTRY_PATH} has no channel/web item with dependencies.`);
  }
  const dependencies = Object.fromEntries(
    item.dependencies.map((spec) => {
      const at = spec.lastIndexOf("@");
      return at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, "latest"];
    }),
  );
  const manifest = `${JSON.stringify({ name: "web-chat-template", private: true, dependencies }, null, 2)}\n`;
  // Written only after an install succeeds, so a failed one is retried.
  const installedPath = join(INSTALL_ROOT, "installed.json");
  if ((await readFile(installedPath, "utf8").catch(() => undefined)) !== manifest) {
    await mkdir(INSTALL_ROOT, { recursive: true });
    await writeFile(join(INSTALL_ROOT, "package.json"), manifest);
    await promisify(execFile)("pnpm", ["install", "--ignore-workspace", "--prefer-offline"], {
      cwd: INSTALL_ROOT,
    });
    await writeFile(installedPath, manifest);
  }
  const appRoot = await mkdtemp(join(tmpdir(), "eve-web-chat-app-"));
  await cp(TEMPLATE_ROOT, appRoot, {
    filter: (source) => !source.slice(TEMPLATE_ROOT.length).startsWith("node_modules"),
    recursive: true,
  });
  await symlink(join(INSTALL_ROOT, "node_modules"), join(appRoot, "node_modules"), "dir");
  return appRoot;
}

async function bundleTemplate(): Promise<string> {
  // Loaded on demand so the other channels' conformance files skip the bundler.
  const { build, defaultClientConditions } = await import("vite");
  const appRoot = await installTemplate();
  const outDir = await mkdtemp(join(tmpdir(), "eve-web-chat-"));
  await build({
    build: {
      copyPublicDir: false,
      minify: false,
      outDir,
      rollupOptions: {
        input: ENTRY_ID,
        output: {
          assetFileNames: ({ names }) =>
            names.some((name) => name.endsWith(".css"))
              ? "app.css"
              : "assets/[name]-[hash][extname]",
          entryFileNames: "app.js",
        },
        // Next reads the template's "use client" directives; a plain bundle doesn't need them.
        onwarn(warning, warn) {
          if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
        },
      },
    },
    configFile: false,
    logLevel: "warn",
    plugins: [
      {
        name: "web-chat-entry",
        resolveId: (id) => (id === ENTRY_ID ? `\0${ENTRY_ID}` : undefined),
        load: (id) => (id === `\0${ENTRY_ID}` ? ENTRY_SOURCE : undefined),
      },
    ],
    resolve: {
      alias: [
        { find: /^@\//u, replacement: `${appRoot}/` },
        // Test the eve source under change, not its last build.
        { find: /^eve\/react$/u, replacement: join(EVE_SOURCE_ROOT, "react/index.ts") },
      ],
      // Resolves eve's `#*.js` imports to `src/*.ts`.
      conditions: [...defaultClientConditions, "eve-source"],
      dedupe: ["react", "react-dom"],
    },
    root: appRoot,
  });
  return outDir;
}

/**
 * Serves the bundled page and forwards everything else to `host` through the
 * global `fetch`, which the harness routes to the eve channel. Response bodies
 * stream through, so the browser sees the session stream as it's written.
 */
async function servePage(host: string, assets: string) {
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html" }).end(PAGE_HTML);
      return;
    }
    if (request.method === "GET" && /^\/(?:app\.(?:js|css)|assets\/[\w.-]+)$/u.test(url.pathname)) {
      response
        .writeHead(200, { "content-type": contentType(url.pathname) })
        .end(await readFile(join(assets, url.pathname)));
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string" && !["connection", "host"].includes(name)) {
        headers.set(name, value);
      }
    }
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const upstream = await fetch(new URL(`${url.pathname}${url.search}`, host), {
      body: hasBody ? await readBody(request) : undefined,
      headers,
      method: request.method,
    });
    const responseHeaders = Object.fromEntries(
      [...upstream.headers].filter(
        ([name]) => !["content-length", "transfer-encoding"].includes(name),
      ),
    );
    response.writeHead(upstream.status, responseHeaders);
    if (upstream.body === null) {
      response.end();
      return;
    }
    const reader = upstream.body.getReader();
    // A closed tab releases the session stream it was reading.
    response.on("close", () => void reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(value);
    }
    response.end();
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function contentType(pathname: string): string {
  if (pathname.endsWith(".js")) return "text/javascript";
  if (pathname.endsWith(".css")) return "text/css";
  return "application/octet-stream";
}
