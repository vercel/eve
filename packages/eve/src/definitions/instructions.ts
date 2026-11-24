import { normalizeInstructionsDefinition } from "#internal/authored-definition/core.js";
import type { InstructionsDefinition } from "#public/definitions/instructions.js";
import type { AlsContext } from "#context/container.js";
import type { Announcement } from "#harness/announcements.js";
import { digestOf } from "#definitions/state.js";
import { agentInstructionsOf, renderInstructionsBlock } from "#runtime/prompt/compose.js";
import { compiledBundleOf } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedDynamicDefinition } from "#runtime/types.js";
import { createWorkspacePromptSection } from "#runtime/workspace/spec.js";
import { isBrandedInstructionsEntry } from "#shared/instructions-definition.js";
import type { JsonValue } from "#shared/json.js";
import { authoredEvaluate, type Definition, section, SECTION_ORDER } from "./definition.js";

type Instruction = { readonly role: "system" | "user"; readonly content: string };

type KeyedInstruction = Instruction & { readonly key: string };

type KeptInstructionsMap = {
  readonly entries: readonly KeyedInstruction[];
  readonly retired?: readonly string[];
};

type KeptInstructions = Instruction | KeptInstructionsMap | null;

export const instructions: Definition = {
  contribute: ({ container }) => ({
    announcements: () =>
      Object.fromEntries(
        staticUserInstructions(container).map(({ content, key }) => [
          key,
          userInstruction(content, digestOf(content)),
        ]),
      ),
    system: () => {
      const block = agentInstructionsOf(compiledBundleOf(container)?.resolvedAgent.instructions);
      return [
        section("eve.instructions", block === undefined ? "" : renderInstructionsBlock(block), {
          order: SECTION_ORDER.instructions,
        }),
      ];
    },
  }),
  id: "eve.instructions",
  label: "the agent's instructions",
};

export const workspace: Definition = {
  contribute: ({ container }) => ({
    system: () => {
      const spec = compiledBundleOf(container)?.turnAgent?.workspaceSpec;
      const text = spec === undefined ? undefined : createWorkspacePromptSection(spec);
      return text === undefined
        ? []
        : [section("eve.workspace", text, { order: SECTION_ORDER.workspace })];
    },
  }),
  id: "eve.workspace",
  label: "the agent's workspace",
};

export function instructionsDefinition(
  resolver: ResolvedDynamicDefinition<"instructions">,
): Definition {
  const id = `instructions:${resolver.slug}`;
  const evaluate = authoredEvaluate(resolver.evaluate);
  return {
    contribute: (ctx) => {
      const kept = async () =>
        await ctx.keep(async (evaluation, previous) => ({
          value: keepInstructions(resolver, id, await evaluate(evaluation), previous),
        }));
      return {
        announcements: async () => {
          const value = (await kept())?.value as KeptInstructions | undefined;
          if (value === undefined) return {};
          return announcementsOf(id, value);
        },
        system: async () => {
          const value = (await kept())?.value as KeptInstructions | undefined;
          return systemSectionsOf(id, value);
        },
      };
    },
    id,
    label: resolver.logicalPath,
  };
}

function isKeptInstructionsMap(value: KeptInstructions): value is KeptInstructionsMap {
  return value !== null && !Array.isArray(value) && Object.hasOwn(value, "entries");
}

function previousUserKeys(previous: JsonValue | undefined, id: string): Set<string> {
  if (
    previous === null ||
    previous === undefined ||
    typeof previous !== "object" ||
    Array.isArray(previous)
  ) {
    return new Set();
  }
  const value = previous as Exclude<KeptInstructions, null>;
  if (isKeptInstructionsMap(value)) {
    const keys = new Set<string>(value.retired ?? []);
    for (const entry of value.entries) {
      if (entry.role === "user") keys.add(entry.key);
    }
    return keys;
  }
  return value.role === "user" ? new Set([id]) : new Set();
}

function keepInstructions(
  resolver: ResolvedDynamicDefinition<"instructions">,
  id: string,
  result: unknown,
  previous: JsonValue | undefined,
): KeptInstructions {
  const known = previousUserKeys(previous, id);
  const parsed = instructionsOf(resolver, id, result);
  const activeUser = new Set(
    parsed.entries.filter((entry) => entry.role === "user").map((entry) => entry.key),
  );
  const retired = [...known].filter((key) => !activeUser.has(key)).sort();
  const hasMapRetired = retired.some((key) => key !== id);
  if (parsed.kind === "empty") {
    return hasMapRetired ? { entries: [], retired } : null;
  }
  if (parsed.kind === "single") {
    const single = parsed.entries[0]!;
    if (!hasMapRetired) return { content: single.content, role: single.role };
    return { entries: [single], retired };
  }
  return retired.length > 0 ? { entries: parsed.entries, retired } : { entries: parsed.entries };
}

function announcementsOf(
  id: string,
  value: KeptInstructions,
): Readonly<Record<string, Announcement>> {
  if (value === null) {
    return { [id]: userInstruction(undefined, "") };
  }
  if (!isKeptInstructionsMap(value)) {
    return {
      [id]: userInstruction(value.role === "user" ? value.content : undefined, digestOf(value)),
    };
  }
  const result: Record<string, Announcement> = {};
  for (const entry of value.entries) {
    if (entry.role === "user") {
      result[entry.key] = userInstruction(
        entry.content,
        digestOf({ content: entry.content, role: entry.role }),
      );
    }
  }
  for (const key of value.retired ?? []) {
    if (!(key in result)) {
      result[key] = userInstruction(undefined, "");
    }
  }
  return result;
}

function systemSectionsOf(id: string, value: KeptInstructions | undefined) {
  if (value === null || value === undefined) return [];
  if (!isKeptInstructionsMap(value)) {
    return value.role === "system" && value.content !== ""
      ? [
          section(id, value.content, {
            order: SECTION_ORDER.dynamicInstructions,
            part: "own",
          }),
        ]
      : [];
  }
  return value.entries
    .filter((entry) => entry.role === "system" && entry.content !== "")
    .map((entry) =>
      section(entry.key, entry.content, {
        order: SECTION_ORDER.dynamicInstructions,
        part: "own",
      }),
    );
}

type ParsedInstructions =
  | { readonly kind: "empty"; readonly entries: readonly [] }
  | { readonly kind: "single"; readonly entries: readonly [KeyedInstruction] }
  | { readonly kind: "map"; readonly entries: readonly KeyedInstruction[] };

function instructionsOf(
  resolver: ResolvedDynamicDefinition<"instructions">,
  id: string,
  result: unknown,
): ParsedInstructions {
  if (result === null || result === undefined) return { entries: [], kind: "empty" };
  if (isBrandedInstructionsEntry(result)) {
    const single = normalizeEntry(result as InstructionsDefinition);
    return single === null
      ? { entries: [], kind: "empty" }
      : { entries: [{ ...single, key: id }], kind: "single" };
  }
  if (!isPlainObject(result)) {
    throw new Error(
      `The dynamic instructions "${resolver.slug}" must return defineInstructions(), a map of defineInstructions() values, or null.`,
    );
  }
  if (isUnbrandedSingleInstruction(result)) {
    throw new Error(
      `The dynamic instructions "${resolver.slug}" returned an unbranded value — wrap with defineInstructions().`,
    );
  }
  const entries: KeyedInstruction[] = [];
  for (const [entryKey, entryValue] of Object.entries(result)) {
    if (entryKey.trim().length === 0 || hasControlChar(entryKey)) {
      throw new Error(
        `The dynamic instructions "${resolver.slug}" returned an invalid instruction key ${JSON.stringify(entryKey)} — keys must be non-empty strings without control characters.`,
      );
    }
    if (!isBrandedInstructionsEntry(entryValue)) {
      throw new Error(
        `The dynamic instructions "${resolver.slug}" returned an unbranded value for "${entryKey}" — wrap with defineInstructions().`,
      );
    }
    const normalized = normalizeEntry(entryValue as InstructionsDefinition);
    if (normalized !== null) {
      entries.push({ ...normalized, key: `${id}\0${entryKey}` });
    }
  }
  return { entries, kind: "map" };
}

function isUnbrandedSingleInstruction(value: Record<string, unknown>): boolean {
  return (
    typeof value.content === "string" &&
    Object.keys(value).every((key) => key === "content" || key === "role")
  );
}

function normalizeEntry(entry: InstructionsDefinition): Instruction | null {
  const normalized = normalizeInstructionsDefinition(
    entry,
    "Expected dynamic instructions to match the public eve shape.",
  );
  const content = normalized.content.trim();
  return content.length === 0 ? null : { content, role: normalized.role ?? "system" };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function userInstruction(content: string | undefined, digest: string): Announcement {
  return {
    initial: "",
    kind: "context.instruction",
    render: () => content,
    value: content === undefined ? "" : digest,
  };
}

export function staticUserInstructions(
  container: Pick<AlsContext, "get">,
): readonly { readonly key: string; readonly content: string }[] {
  return (compiledBundleOf(container)?.resolvedAgent.instructions ?? []).flatMap((entry) => {
    const content = entry.content.trim();
    return entry.role === "user" && content.length > 0
      ? [{ content, key: `eve.instructions:${entry.name}` }]
      : [];
  });
}
