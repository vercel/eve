import type { ResolvedSkillDefinition } from "#runtime/types.js";

/** Largest skill file (instructions or supporting file) served over MCP. */
export const MCP_SKILL_FILE_MAX_BYTES = 512 * 1024;

export interface McpSkillResource {
  readonly _meta: Readonly<Record<string, unknown>>;
  readonly description: string;
  readonly mimeType: string;
  readonly name: string;
  readonly uri: string;
}

export type McpSkillResourceContents =
  | { readonly mimeType: string; readonly text: string; readonly uri: string }
  | { readonly blob: string; readonly mimeType: string; readonly uri: string };

export interface ParsedSkillResourceUri {
  readonly path?: string;
  readonly skill: ResolvedSkillDefinition;
}

function skillUriPrefix(agentName: string): string {
  return `skill://${encodeURIComponent(agentName)}/`;
}

export function skillResourceUri(agentName: string, skillName: string, path?: string): string {
  const base = `${skillUriPrefix(agentName)}${encodeURIComponent(skillName)}`;
  return path === undefined ? base : `${base}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** One `skill://` resource per compiled skill. */
export function listSkillResources(
  agentName: string,
  skills: readonly ResolvedSkillDefinition[],
): McpSkillResource[] {
  return skills.map((skill) => ({
    _meta: {
      "eve.dev/files": [...(skill.fileIndex ?? [])],
      "eve.dev/kind": "skill",
      "eve.dev/owner": agentName,
    },
    description: skill.description,
    mimeType: "text/markdown",
    name: skill.name,
    uri: skillResourceUri(agentName, skill.name),
  }));
}

export function skillResourceTemplates(agentName: string) {
  return [
    {
      description: `A supporting file of one of ${agentName}'s skills. Paths are listed in each skill resource's _meta["eve.dev/files"].`,
      name: "skill-file",
      uriTemplate: `${skillUriPrefix(agentName)}{skill}/{+path}`,
    },
  ];
}

/**
 * Resolves `skill://<agent>/<skill>[/<path>]` to a compiled skill and a
 * normalized relative path. Returns `undefined` for anything that is not an
 * exact, safe reference: foreign agents, unknown skills, encoded separators,
 * dot segments, and paths absent from the compiled file index.
 */
export function parseSkillResourceUri(
  agentName: string,
  skills: readonly ResolvedSkillDefinition[],
  uri: string,
): ParsedSkillResourceUri | undefined {
  const prefix = skillUriPrefix(agentName);
  if (!uri.startsWith(prefix) || uri.includes("?") || uri.includes("#")) return undefined;
  const segments = decodeSegments(uri.slice(prefix.length).split("/"));
  if (segments === undefined || segments.length === 0) return undefined;
  const [skillName, ...pathSegments] = segments;
  const skill = skills.find((candidate) => candidate.name === skillName);
  if (skill === undefined) return undefined;
  if (pathSegments.length === 0) return { skill };

  const path = pathSegments.join("/");
  if (path === "SKILL.md") return { skill };
  if (skill.fileIndex !== undefined && !skill.fileIndex.includes(path)) return undefined;
  return { path, skill };
}

function decodeSegments(raw: readonly string[]): string[] | undefined {
  const decoded: string[] = [];
  for (const segment of raw) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (
      value.length === 0 ||
      value === "." ||
      value === ".." ||
      value.includes("/") ||
      value.includes("\\") ||
      value.includes("\0")
    ) {
      return undefined;
    }
    decoded.push(value);
  }
  return decoded;
}

/** Encodes skill file bytes as MCP resource contents: UTF-8 text, else a blob. */
export function skillFileContents(
  uri: string,
  path: string,
  bytes: Uint8Array,
): McpSkillResourceContents {
  if (bytes.byteLength > MCP_SKILL_FILE_MAX_BYTES) {
    throw new Error(
      `Skill file exceeds the ${String(MCP_SKILL_FILE_MAX_BYTES / 1024)} KiB MCP limit.`,
    );
  }
  const mimeType = skillFileMimeType(path);
  try {
    return { mimeType, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), uri };
  } catch {
    return {
      blob: Buffer.from(bytes).toString("base64"),
      mimeType: mimeType.startsWith("text/") ? "application/octet-stream" : mimeType,
      uri,
    };
  }
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  css: "text/css",
  csv: "text/csv",
  html: "text/html",
  js: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  mjs: "text/javascript",
  pdf: "application/pdf",
  png: "image/png",
  py: "text/x-python",
  sh: "text/x-shellscript",
  sql: "application/sql",
  ts: "text/typescript",
  txt: "text/plain",
  yaml: "application/yaml",
  yml: "application/yaml",
};

function skillFileMimeType(path: string): string {
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  return MIME_TYPES[extension] ?? "application/octet-stream";
}
