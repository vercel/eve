import type { FilePart, TextPart, UserContent } from "ai";

import type { FetchFileResult } from "#channel/adapter.js";
import { EveAttachmentError } from "#internal/attachments/errors.js";
import { createLogger } from "#internal/logging.js";
import {
  resolveTeamsAccessToken,
  type TeamsApiOptions,
  type TeamsAttachment,
} from "#public/channels/teams/api.js";
import {
  evaluateFilePart,
  formatUploadPolicyViolation,
  isUploadsDisabled,
  mergeUploadPolicy,
  type UploadPolicyInput,
} from "#public/channels/upload-policy.js";
import type { UploadPolicy } from "#public/channels/upload-policy.js";
import { isObject } from "#shared/guards.js";

const log = createLogger("teams.attachments");

const BOT_CONNECTOR_HOSTS = new Set([
  "smba.trafficmanager.net",
  "smba.infra.gcc.teams.microsoft.com",
  "smba.infra.gov.teams.microsoft.us",
  "smba.infra.dod.teams.microsoft.us",
]);
const MAX_FILE_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** File handling options for the native Teams channel. */
export interface TeamsFilesConfig {
  /**
   * Hosts whose file URLs may be fetched, or `"*"` for any host. Defaults to
   * `[]` (no hosts), so attachments are dropped until you allowlist their host.
   */
  readonly allowedHosts?: readonly string[] | "*";
  /** Enable inbound attachment ingestion. Off unless explicitly `true`. */
  readonly enabled?: boolean;
  /** Size and type limits applied to accepted attachments. */
  readonly uploadPolicy?: UploadPolicyInput;
}

/** Normalized file handling policy used by the Teams channel. */
export interface TeamsFilesPolicy {
  readonly allowedHosts: readonly string[] | "*";
  readonly enabled: boolean;
  readonly uploadPolicy: UploadPolicy;
}

/** Normalizes author-provided Teams file options. */
export function normalizeTeamsFilesPolicy(config: TeamsFilesConfig | undefined): TeamsFilesPolicy {
  return {
    allowedHosts: config?.allowedHosts ?? [],
    enabled: config?.enabled === true,
    uploadPolicy: mergeUploadPolicy(config?.uploadPolicy),
  };
}

/** Collects Teams attachment file parts when file support is explicitly enabled. */
export function collectTeamsFileParts(
  attachments: readonly TeamsAttachment[],
  policy: TeamsFilesPolicy,
): FilePart[] {
  if (!policy.enabled || isUploadsDisabled(policy.uploadPolicy)) return [];

  const parts: FilePart[] = [];
  for (const attachment of attachments) {
    const part = toTeamsFilePart(attachment, parts.length, policy);
    if (part === null) continue;
    const violation = evaluateFilePart(part, policy.uploadPolicy);
    if (violation !== null) {
      log.warn(`dropped Teams attachment — ${formatUploadPolicyViolation(violation)}`, {
        name: attachment.name,
      });
      continue;
    }
    parts.push(part);
  }
  return parts;
}

/** Combines text + file parts into the UserContent shape expected by the harness. */
export function buildTeamsTurnMessage(
  text: string,
  fileParts: readonly FilePart[],
): string | UserContent {
  if (fileParts.length === 0) return text;
  const trimmed = text.trim();
  if (trimmed.length === 0) return [...fileParts];
  const textPart: TextPart = { type: "text", text };
  return [textPart, ...fileParts];
}

/**
 * Builds the channel `fetchFile` resolver for Teams file URLs. Returns null when
 * files are disabled or the URL host is not in `allowedHosts`; otherwise fetches
 * the bytes and throws on a non-2xx response.
 */
export function createTeamsFetchFile(
  policy: TeamsFilesPolicy,
  api: TeamsApiOptions = {},
): (url: string) => Promise<FetchFileResult | null> {
  return async (url) => {
    if (!policy.enabled || !isAllowedUrl(url, policy.allowedHosts)) return null;
    const { response, finalUrl } = await fetchTeamsFile(url, policy.allowedHosts, api);
    if (!response.ok) {
      throw attachmentError(
        `Teams file fetch returned HTTP ${response.status} for host ${finalUrl.hostname}.`,
      );
    }
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      mediaType: response.headers.get("content-type") ?? undefined,
    };
  };
}

async function fetchTeamsFile(
  url: string,
  allowedHosts: readonly string[] | "*",
  api: TeamsApiOptions,
): Promise<{ readonly finalUrl: URL; readonly response: Response }> {
  const apiFetch = api.fetch ?? fetch;
  let currentUrl = new URL(url);
  let connectorToken: string | undefined;

  for (let redirectCount = 0; redirectCount <= MAX_FILE_REDIRECTS; redirectCount += 1) {
    const isBotConnectorUrl =
      currentUrl.port === "" && BOT_CONNECTOR_HOSTS.has(currentUrl.hostname);
    const headers = new Headers();
    if (isBotConnectorUrl) {
      connectorToken ??= await resolveTeamsAccessToken(api);
      headers.set("authorization", `Bearer ${connectorToken}`);
    }
    const response = await apiFetch(currentUrl, {
      headers,
      redirect: "manual",
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { finalUrl: currentUrl, response };
    }
    if (redirectCount === MAX_FILE_REDIRECTS) {
      throw attachmentError(`Teams file fetch exceeded ${MAX_FILE_REDIRECTS} redirects.`);
    }
    const location = response.headers.get("location");
    if (location === null) {
      throw attachmentError(
        `Teams file fetch redirect from host ${currentUrl.hostname} had no location.`,
      );
    }
    const nextUrl = new URL(location, currentUrl);
    if (!isAllowedUrl(nextUrl.href, allowedHosts)) {
      throw attachmentError(
        `Teams file fetch redirect to host ${nextUrl.hostname} is not allowed.`,
      );
    }
    currentUrl = nextUrl;
  }

  throw attachmentError(`Teams file fetch exceeded ${MAX_FILE_REDIRECTS} redirects.`);
}

function attachmentError(message: string): EveAttachmentError {
  return new EveAttachmentError({ adapterKind: "teams", kind: "resolver-threw", message });
}

function toTeamsFilePart(
  attachment: TeamsAttachment,
  index: number,
  policy: TeamsFilesPolicy,
): FilePart | null {
  const url = readAttachmentUrl(attachment);
  if (!url || !isAllowedUrl(url, policy.allowedHosts)) return null;

  return {
    data: new URL(url),
    filename: attachment.name ?? `teams-attachment-${index}`,
    mediaType: inferMediaType(attachment),
    type: "file",
  };
}

function readAttachmentUrl(attachment: TeamsAttachment): string | null {
  if (
    attachment.contentType === "application/vnd.microsoft.teams.file.download.info" &&
    isObject(attachment.content) &&
    typeof attachment.content.downloadUrl === "string"
  ) {
    return attachment.content.downloadUrl;
  }
  if (
    attachment.contentUrl &&
    !attachment.contentType.startsWith("application/vnd.microsoft.card.")
  ) {
    return attachment.contentUrl;
  }
  return null;
}

function inferMediaType(attachment: TeamsAttachment): string {
  if (attachment.contentType === "application/vnd.microsoft.teams.file.download.info") {
    const fileType =
      isObject(attachment.content) && typeof attachment.content.fileType === "string"
        ? attachment.content.fileType
        : undefined;
    if (fileType === "txt") return "text/plain";
  }
  return attachment.contentType || "application/octet-stream";
}

function isAllowedUrl(url: string, allowedHosts: readonly string[] | "*"): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (allowedHosts === "*") return true;
  return allowedHosts.some((host) =>
    host.includes(":") ? parsed.host === host : parsed.port === "" && parsed.hostname === host,
  );
}
