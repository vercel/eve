import { parse, type DefaultTreeAdapterMap } from "parse5";
import { productUrl } from "../watches/product-url.ts";
import { getPublicResource } from "../watches/public-resource.ts";
import { maximumBrowserImageBytes } from "./artifact.ts";

const omittedTags = new Set([
  "button",
  "canvas",
  "embed",
  "form",
  "frame",
  "iframe",
  "input",
  "nav",
  "noscript",
  "object",
  "script",
  "select",
  "style",
  "svg",
  "template",
  "textarea",
]);
const maxTextLength = 8_000;

export async function readPublicResearchPage(url: string, signal: AbortSignal) {
  const page = await readResource(url, {
    accept: "text/html",
    contentType: /^text\/html\b/i,
    maxBytes: 1024 * 1024,
    signal,
  });
  return parsePublicResearchPage(page.bytes.toString("utf8"), page.url);
}

export async function readPublicResearchImage(url: string, signal: AbortSignal) {
  const asset = await readResource(url, {
    accept: "image/png,image/jpeg,image/webp,image/gif",
    contentType: /^image\/(?:png|jpeg|webp|gif)\b/i,
    maxBytes: maximumBrowserImageBytes,
    signal,
  });
  return asset.bytes;
}

async function readResource(input: string, options: Parameters<typeof getPublicResource>[1]) {
  let url = productUrl(input);
  for (let redirects = 0; redirects <= 2; redirects++) {
    const response = await getPublicResource(url, options);
    if ("bytes" in response) return { bytes: response.bytes, url };
    url = productUrl(new URL(response.redirect, url).href);
  }
  throw new Error("The public resource redirected too many times.");
}

export function parsePublicResearchPage(html: string, url: URL) {
  type Node = DefaultTreeAdapterMap["node"];
  const nodes: { node: Node; inBody: boolean }[] = [{ node: parse(html), inBody: false }];
  const links = new Set<string>();
  const text: string[] = [];
  let textLength = 0;
  let title = "";
  let imageUrl: string | undefined;
  while (nodes.length) {
    const entry = nodes.pop();
    if (!entry) break;
    const { node, inBody } = entry;
    if (inBody && "value" in node && textLength < maxTextLength) {
      const value = node.value
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, maxTextLength - textLength);
      if (value) {
        text.push(value);
        textLength += value.length + 1;
      }
    }
    if ("tagName" in node) {
      const { tagName, attrs } = node;
      const attribute = (name: string) => attrs.find((item) => item.name === name)?.value;
      if (
        omittedTags.has(tagName) ||
        attribute("hidden") !== undefined ||
        attribute("contenteditable") !== undefined ||
        attribute("aria-hidden") === "true"
      )
        continue;
      if (tagName === "title") {
        const child = node.childNodes.find((item) => "value" in item);
        if (child && "value" in child) title = child.value.trim().slice(0, 200);
      }
      if (tagName === "meta" && attribute("property") === "og:image") {
        imageUrl ??= publicHref(attribute("content"), url);
      }
      if (inBody && tagName === "a" && links.size < 20) {
        const href = publicHref(attribute("href"), url);
        if (href) links.add(href);
      }
    }
    if ("childNodes" in node) {
      const body = inBody || ("tagName" in node && node.tagName === "body");
      for (const child of [...node.childNodes].reverse()) nodes.push({ node: child, inBody: body });
    }
  }
  return {
    url: url.href,
    title: title || url.hostname,
    text: text.join(" "),
    links: [...links],
    imageUrl,
  };
}

function publicHref(value: string | undefined, base: URL) {
  if (!value || value.length > 2_048) return undefined;
  const url = URL.parse(value, base);
  if (!url) return undefined;
  try {
    return productUrl(url.href).href;
  } catch {
    return undefined;
  }
}

export function renderPublicResearchPreview(page: ReturnType<typeof parsePublicResearchPage>) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body{font:18px/1.6 system-ui;background:#fff;color:#171717;margin:48px}h1{line-height:1.2}p{overflow-wrap:anywhere}</style>
</head><body><main id="public-research-preview">
<p>Public page preview · ${escapeHtml(new URL(page.url).hostname)}</p>
<h1>${escapeHtml(page.title)}</h1><p>${escapeHtml(page.text.slice(0, 2_000))}</p>
</main></body></html>`;
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
