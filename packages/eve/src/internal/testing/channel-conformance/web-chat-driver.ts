import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Browser, Locator, Page } from "playwright-core";

import type {
  ClientDriver,
  RenderedOption,
  ShownText,
} from "#internal/testing/channel-conformance/harness.js";

const TEMPLATE_ROOT = fileURLToPath(
  new URL("../../../../../../apps/docs/registry/channel/web/", import.meta.url),
);
const REGISTRY_PATH = fileURLToPath(
  new URL("../../../../../../apps/docs/registry.json", import.meta.url),
);
const INSTALL_ROOT = join(tmpdir(), "eve-web-chat-template");
const EVE_SOURCE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const ENTRY_ID = "virtual:web-chat-entry";
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

interface WebChatTab {
  readonly host: string;
  readonly browser: Browser;
  readonly page: Page;
  readonly origin: { readonly url: string; close(): Promise<void> };
  readonly errors: string[];
}

let shared: Promise<WebChatTab> | undefined;

async function openTab(host: string, assets: string): Promise<WebChatTab> {
  const origin = await servePage(host, assets);
  try {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(2_000);
    page.setDefaultNavigationTimeout(30_000);
    await page.addInitScript(() => {
      try {
        sessionStorage.clear();
        localStorage.clear();
      } catch {}
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => void errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    return { browser, errors, host, origin, page };
  } catch (error) {
    await origin.close();
    throw error;
  }
}

async function closeWebChatBrowser(): Promise<void> {
  const tab = shared;
  shared = undefined;
  const opened = await tab?.catch(() => undefined);
  if (opened === undefined) return;
  try {
    await opened.browser.close();
  } finally {
    await opened.origin.close();
  }
}

export function webChatDriver(): ClientDriver {
  return {
    name: "web chat",
    capabilities: ["attachments", "buttons", "text-replies"],
    surface: "private",
    async open(host, wait) {
      const assets = await (bundled ??= bundleTemplate());
      const tab = await (shared ??= openTab(host, assets).catch((error: unknown) => {
        shared = undefined;
        throw error;
      }));
      if (tab.host !== host) {
        throw new Error(`The web chat tab forwards to ${tab.host}, not to ${host}.`);
      }
      const { errors, origin, page } = tab;
      const close = async () => {
        await page.goto("about:blank").catch(async (error: unknown) => {
          await closeWebChatBrowser();
          throw error;
        });
      };
      errors.length = 0;
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
        await page.context().clearCookies();
        await page.goto(origin.url);
        await wait(
          "the composer",
          async () => {
            await look();
            return (await composer.isEditable()) ? true : undefined;
          },
          describe,
        );
      } catch (error) {
        await closeWebChatBrowser();
        throw error;
      }

      return {
        async say(text, _person, files) {
          if (files !== undefined && files.length > 0) {
            await page.locator('input[type="file"]').setInputFiles(
              files.map((file) => ({
                buffer: Buffer.from(file.bytes),
                mimeType: file.mediaType,
                name: file.name,
              })),
            );
          }
          await composer.fill(text);
          await composer.press("Enter");
        },
        waitForQuestion: (prompts) =>
          wait(
            `one of the questions ${JSON.stringify(prompts)}`,
            async () => {
              await look();
              const texts = (await page.locator("p, legend").allInnerTexts()).map((text) =>
                text.trim(),
              );
              const shown = prompts
                .filter((prompt) => texts.includes(prompt))
                .sort((a, b) => texts.lastIndexOf(a) - texts.lastIndexOf(b));
              for (const prompt of shown) {
                const options = await promptOptions(page, prompt).catch(() => undefined);
                if (options !== undefined) return { options, prompt };
              }
              return undefined;
            },
            describe,
          ),
        async press(option) {
          for (const control of option.handle as readonly Locator[]) {
            const pressable =
              (await control.count()) > 0 && (await control.isEnabled().catch(() => false));
            if (!pressable) return;
            await control.click().catch(() => {});
          }
        },
        async replies() {
          await look();
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
          for (let attempt = 1; ; attempt += 1) {
            const shown = await readShown(page).catch((error: unknown) => {
              if (attempt >= SHOWN_READ_ATTEMPTS) throw error;
              return undefined;
            });
            if (shown !== undefined) return shown;
          }
        },
        describe,
        close,
      };
    },
    dispose: closeWebChatBrowser,
  };
}

async function promptOptions(page: Page, prompt: string): Promise<RenderedOption[] | undefined> {
  return (
    (await questionOptions(page, prompt)) ??
    (await approvalOptions(page, prompt)) ??
    (await openEndedQuestion(page, prompt))
  );
}

async function openEndedQuestion(page: Page, prompt: string): Promise<[] | undefined> {
  const group = questionGroup(page, prompt);
  const field = group.getByRole("textbox", { name: "Answer" });
  if ((await field.count()) === 0 || !(await field.isEditable().catch(() => false))) {
    return undefined;
  }
  return (await group.getByRole("radio").count()) === 0 ? [] : undefined;
}

async function questionOptions(page: Page, prompt: string): Promise<RenderedOption[] | undefined> {
  const group = questionGroup(page, prompt);
  const radios = await group.getByRole("radio").all();
  if (radios.length === 0) return undefined;
  const answer = page
    .locator("form")
    .filter({ has: group })
    .getByRole("button", { name: "Answer" });
  const options: RenderedOption[] = [];
  for (const radio of radios) {
    if (!(await radio.isEnabled())) return undefined;
    const label = await firstLine(radio.locator("xpath=ancestor::label[1]"));
    options.push({ handle: [radio, answer], label });
  }
  return options;
}

function questionGroup(page: Page, prompt: string): Locator {
  return page.getByRole("group", { exact: true, name: prompt }).last();
}

async function approvalOptions(page: Page, prompt: string): Promise<RenderedOption[] | undefined> {
  const label = page.locator("p").getByText(prompt, { exact: true }).last();
  if ((await label.count()) === 0) return undefined;
  return await readButtons(label.locator("xpath=..").getByRole("button"));
}

async function readButtons(buttons: Locator): Promise<RenderedOption[] | undefined> {
  const all = await buttons.all();
  if (all.length === 0) return undefined;
  const options: RenderedOption[] = [];
  for (const button of all) {
    if (!(await button.isEnabled())) return undefined;
    options.push({ handle: [button], label: await firstLine(button) });
  }
  return options;
}

async function firstLine(element: Locator): Promise<string> {
  const lines = (await element.innerText()).split("\n").map((line) => line.trim());
  return lines.find((line) => line.length > 0) ?? "";
}

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
  const { build, defaultClientConditions } = await import("vite");
  const appRoot = await installTemplate();
  const outDir = await mkdtemp(join(tmpdir(), "eve-web-chat-"));
  await build({
    build: {
      copyPublicDir: false,
      minify: true,
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
        { find: /^eve\/client$/u, replacement: join(EVE_SOURCE_ROOT, "client/index.ts") },
        { find: /^eve\/react$/u, replacement: join(EVE_SOURCE_ROOT, "react/index.ts") },
        { find: /^eve\/events$/u, replacement: join(EVE_SOURCE_ROOT, "public/events/index.ts") },
      ],
      conditions: [...defaultClientConditions, "eve-source"],
      dedupe: ["react", "react-dom"],
    },
    root: appRoot,
  });
  return outDir;
}

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
        .writeHead(200, {
          "cache-control": "max-age=3600, immutable",
          "content-type": contentType(url.pathname),
        })
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

const SHOWN_READ_ATTEMPTS = 5;

async function readShown(page: Page): Promise<ShownText[]> {
  const shown: ShownText[] = [];
  for (const message of await page.locator(".is-assistant").all()) {
    const links: string[] = [];
    for (const anchor of await message.locator("a[href]").all()) {
      const href = await anchor.getAttribute("href", { timeout: 100 }).catch(() => null);
      if (href !== null) links.push(href);
    }
    const text = [await message.innerText({ timeout: 500 }), ...links].join("\n");
    const options = (await readButtons(message.getByRole("button"))) ?? [];
    shown.push({ onlyPerson: true, options, text });
  }
  return shown;
}
