import { execFile as execFileWithCallback } from "node:child_process";
import { promisify } from "node:util";

import { z } from "#compiled/zod/index.js";
import { toErrorMessage } from "#shared/errors.js";

const CODEX_PROVIDER = "codex";
const CODEX_CATALOG_MAX_BUFFER_BYTES = 80 * 1024 * 1024;

const execFile = promisify(execFileWithCallback);

const codexCatalogModelSchema = z
  .object({
    context_window: z.number().int().positive().optional(),
    display_name: z.string().min(1).optional(),
    slug: z.string().min(1),
    supported_in_api: z.boolean().optional(),
    visibility: z.string().optional(),
  })
  .passthrough();

const codexCatalogSchema = z
  .object({
    models: z.array(codexCatalogModelSchema),
  })
  .passthrough();

export interface CodexModelCatalogEntry {
  readonly contextWindowTokens?: number;
  readonly displayName: string;
  readonly slug: string;
  readonly visibility?: string;
}

export interface CodexModelCatalogCommand {
  (
    args: readonly string[],
    options: { readonly signal?: AbortSignal },
  ): Promise<{ readonly stdout: string }>;
}

export function formatCodexModelId(slug: string): string {
  return `${CODEX_PROVIDER}/${slug}`;
}

export function parseCodexModelId(modelId: string): string | null {
  const prefix = `${CODEX_PROVIDER}/`;
  if (!modelId.startsWith(prefix)) return null;
  const slug = modelId.slice(prefix.length).trim();
  return slug.length === 0 ? null : slug;
}

export function isCodexProvider(provider: string): boolean {
  return provider.split(".")[0] === CODEX_PROVIDER;
}

export function parseCodexModelCatalog(rawOutput: string): readonly CodexModelCatalogEntry[] {
  const jsonStart = rawOutput.indexOf("{");
  if (jsonStart === -1) {
    throw new Error("Codex model catalog output did not contain JSON.");
  }

  const parsedJson = JSON.parse(rawOutput.slice(jsonStart)) as unknown;
  const parsed = codexCatalogSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error("Codex model catalog output did not match the expected schema.");
  }

  return parsed.data.models.map((model) => ({
    slug: model.slug,
    displayName: model.display_name ?? model.slug,
    ...(model.context_window !== undefined && { contextWindowTokens: model.context_window }),
    ...(model.visibility !== undefined && { visibility: model.visibility }),
  }));
}

export async function fetchCodexModelCatalog(
  input: {
    readonly command?: CodexModelCatalogCommand;
    readonly signal?: AbortSignal;
  } = {},
): Promise<readonly CodexModelCatalogEntry[]> {
  const command = input.command ?? runCodexCatalogCommand;

  try {
    const result = await command(["debug", "models"], { signal: input.signal });
    return parseCodexModelCatalog(result.stdout);
  } catch (error) {
    if (input.signal?.aborted) throw error;
    try {
      const result = await command(["debug", "models", "--bundled"], { signal: input.signal });
      return parseCodexModelCatalog(result.stdout);
    } catch (fallbackError) {
      if (input.signal?.aborted) throw fallbackError;
      throw new Error(
        `Failed to load the Codex model catalog from the local Codex CLI. ${toErrorMessage(fallbackError)}`,
      );
    }
  }
}

export function selectableCodexModels(
  models: readonly CodexModelCatalogEntry[],
): readonly CodexModelCatalogEntry[] {
  const listed = models.filter(
    (model) => model.visibility === undefined || model.visibility === "list",
  );
  return [...listed].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

async function runCodexCatalogCommand(
  args: readonly string[],
  options: { readonly signal?: AbortSignal },
): Promise<{ readonly stdout: string }> {
  const { stdout } = await execFile("codex", [...args], {
    encoding: "utf8",
    maxBuffer: CODEX_CATALOG_MAX_BUFFER_BYTES,
    signal: options.signal,
  });
  return { stdout };
}
