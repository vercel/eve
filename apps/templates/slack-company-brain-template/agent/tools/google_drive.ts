import { connect } from "@vercel/connect/eve";
import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { connectorUid, isConnectorAttached } from "../lib/connect.ts";

const driveAuth = connect(connectorUid("google-drive"));
const DRIVE_API = "https://www.googleapis.com/drive/v3";
// Bounds how much of one file reaches the model.
const MAX_CHARS = 40_000;

// Google's own formats have no file content to download, so Drive exports
// them as text.
const EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

interface DriveFile {
  readonly id: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly modifiedTime?: string;
  readonly webViewLink?: string;
  readonly owners?: readonly { readonly displayName?: string }[];
}

const FILE_FIELDS = "id,name,mimeType,modifiedTime,webViewLink,owners(displayName)";

// Calls the Drive API as the person in the conversation. eve asks them to sign
// in to Google first if they haven't, and again if Google rejects the token.
async function drive(ctx: ToolContext, path: string, params: Record<string, string>) {
  const { token } = await ctx.getToken(driveAuth);
  const response = await fetch(`${DRIVE_API}${path}?${new URLSearchParams(params)}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: ctx.abortSignal,
  });
  if (response.status === 401) ctx.requireAuth(driveAuth);
  return response;
}

// Reads at most `maxChars` characters, then cancels the rest of the body.
async function readText(response: Response, maxChars: number) {
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  while (reader && text.length <= maxChars) {
    const { done, value } = await reader.read();
    if (done) return { text, truncated: false };
    text += value;
  }
  await reader?.cancel();
  return { text: text.slice(0, maxChars), truncated: true };
}

function describe(file: DriveFile) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    modified: file.modifiedTime,
    owner: file.owners?.[0]?.displayName,
    link: file.webViewLink,
  };
}

const searchGoogleDrive = defineTool({
  label: { start: () => "Searching Google Drive", complete: () => "Searched Google Drive" },
  description:
    "Search Google Drive files the person can open, including shared drives, by words in their name or content. Each result has a link to cite inline. Read a match with read_google_drive_file.",
  inputSchema: z.object({
    query: z.string().min(1).max(200).describe("Words to look for in file names and content."),
    limit: z.number().int().min(1).max(25).optional().describe("Maximum results. Default 10."),
  }),
  async execute({ query, limit }, ctx) {
    const escaped = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const response = await drive(ctx, "/files", {
      q: `fullText contains '${escaped}' and trashed = false`,
      fields: `files(${FILE_FIELDS})`,
      pageSize: String(limit ?? 10),
      corpora: "allDrives",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
    });
    if (!response.ok) throw new Error(`Google Drive search failed: HTTP ${response.status}`);
    const { files } = (await response.json()) as { files?: DriveFile[] };
    return { files: (files ?? []).map(describe) };
  },
});

const readGoogleDriveFile = defineTool({
  label: { start: () => "Reading a Google Drive file", complete: () => "Read a Google Drive file" },
  description:
    "Read a Google Drive file's text by its id, such as a search result's id. Docs and Slides come back as plain text, Sheets as CSV of the first sheet, and text files as they are. Other formats, such as PDFs and images, aren't readable.",
  inputSchema: z.object({
    fileId: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, "Pass a Drive file id, such as a search result's id.")
      .describe("Drive file id."),
  }),
  async execute({ fileId }, ctx) {
    const path = `/files/${fileId}`;
    const meta = await drive(ctx, path, { fields: FILE_FIELDS, supportsAllDrives: "true" });
    if (meta.status === 403 || meta.status === 404) {
      return { unavailable: true, message: "That file doesn't exist or the person can't open it." };
    }
    if (!meta.ok) throw new Error(`Google Drive read failed: HTTP ${meta.status}`);
    const file = (await meta.json()) as DriveFile;

    const exportType = file.mimeType ? EXPORTS[file.mimeType] : undefined;
    const readable =
      exportType !== undefined ||
      file.mimeType?.startsWith("text/") ||
      file.mimeType === "application/json";
    if (!readable) {
      return {
        ...describe(file),
        unavailable: true,
        message: `This tool can't read ${file.mimeType ?? "this kind of file"}. Share the link instead.`,
      };
    }

    const content = await drive(
      ctx,
      exportType ? `${path}/export` : path,
      exportType ? { mimeType: exportType } : { alt: "media", supportsAllDrives: "true" },
    );
    if (!content.ok) throw new Error(`Google Drive read failed: HTTP ${content.status}`);
    const { text, truncated } = await readText(content, MAX_CHARS);
    return { ...describe(file), text, truncated: truncated || undefined };
  },
});

// On once `vercel connect create google-drive --connection-method google-child
// --name company-brain` attaches the connector. Each person signs in with
// their own Google account, so the agent reads only files they can open.
export default defineDynamic(async () =>
  (await isConnectorAttached(connectorUid("google-drive")))
    ? { search_google_drive: searchGoogleDrive, read_google_drive_file: readGoogleDriveFile }
    : null,
);
