import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { z } from "zod";

const fileInfo = z.object({
  ok: z.literal(true),
  file: z.object({
    id: z.string(),
    url_private: z.string(),
    filetype: z.string().optional(),
    canvas_creator_id: z.string().min(1).optional(),
  }),
});
const maxResponseBytes = 256 * 1024;
const maxInstructionChars = 8_000;
const ignoredTags = new Set(["form", "script", "style", "template", "title"]);
const blockTags = new Set([
  "blockquote",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "p",
  "pre",
]);

export async function loadSlackCanvas(id: string, token: string): Promise<string | null> {
  try {
    const infoUrl = new URL("https://slack.com/api/files.info");
    infoUrl.searchParams.set("file", id);
    const request = {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    } satisfies RequestInit;
    const info = fileInfo.safeParse(JSON.parse(await fetchText(infoUrl, request)));
    if (!info.success || info.data.file.id !== id) return null;
    const file = info.data.file;
    if (file.filetype !== "canvas" && !file.canvas_creator_id) return null;
    const downloadUrl = URL.parse(file.url_private);
    if (!downloadUrl || !isSlackDownloadUrl(downloadUrl)) return null;

    const html = await fetchText(downloadUrl, request, ["text/html", "application/octet-stream"]);
    const canvas = parseFragment(html);
    if (!canvas.childNodes.some((node) => "tagName" in node)) return null;
    return canvasText(canvas).trim().slice(0, maxInstructionChars).trimEnd() || null;
  } catch {
    return null;
  }
}

function isSlackDownloadUrl(url: URL): boolean {
  if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
  return (
    url.hostname === "files.slack.com" ||
    ((url.hostname === "enterprise.slack.com" || url.hostname.endsWith(".enterprise.slack.com")) &&
      url.pathname.startsWith("/files/"))
  );
}

async function fetchText(
  url: URL,
  request: RequestInit,
  mediaTypes?: readonly string[],
): Promise<string> {
  const response = await fetch(url, request);
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!response.ok || !response.body || (mediaTypes && !mediaTypes.includes(mediaType ?? ""))) {
    await response.body?.cancel();
    throw new Error("Slack did not return a readable response.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        throw new Error("Slack response exceeded the canvas byte limit.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function canvasText(node: DefaultTreeAdapterTypes.Node, depth = 0): string {
  if (depth > 64) return "";
  if ("value" in node) return node.value;
  if (!("childNodes" in node)) return "";
  const tag = "tagName" in node ? node.tagName : "";
  if (ignoredTags.has(tag)) return "";
  if (tag === "br") return "\n";
  const text = node.childNodes.map((child) => canvasText(child, depth + 1)).join("");
  if (tag === "li") return `\n- ${text.trim()}\n`;
  return blockTags.has(tag) ? `\n${text.trim()}\n` : text;
}
