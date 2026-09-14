import {
  escapeForQuote,
  isAstNode,
  keyMatches,
  lineAt,
  parseAgentObject,
  unwrapExpression,
  type AstNode,
  type ObjectExpression,
} from "./agent-config-ast.js";
import {
  CHATGPT_MODEL_SELECTION_PREFIX,
  DEFAULT_CHATGPT_MODEL_SELECTION,
  normalizeChatGptModelId,
  parseChatGptModelSelection,
} from "#shared/chatgpt-model.js";

export type SourceEdit =
  | {
      readonly kind: "applied";
      readonly from: string;
      readonly to: string;
      readonly nextSource: string;
    }
  | {
      readonly kind: "bail";
      readonly reason: string;
      readonly line: number;
    };

/** Rewrites between a Gateway string model and an eve-owned `chatgpt()` call. */
export async function applyModelSelectionToSource(
  sourceText: string,
  selection: string,
): Promise<SourceEdit> {
  const parsed = await parseAgentObject(sourceText);
  if (parsed.kind === "bail") return parsed;
  const value = findModelValue(parsed.object);
  if (value === undefined || value.start === undefined || value.end === undefined) {
    return {
      kind: "bail",
      reason: "`model` is absent or cannot be edited safely",
      line: lineAt(sourceText, parsed.object.start),
    };
  }

  const current = currentSelection(value);
  if (current === undefined) {
    return {
      kind: "bail",
      reason: "`model` is neither a string literal nor an eve `chatgpt()` call",
      line: lineAt(sourceText, value.start),
    };
  }

  const chatGptModelId = parseChatGptModelSelection(selection);
  const replacement =
    chatGptModelId !== undefined
      ? `chatgpt(${JSON.stringify(chatGptModelId)})`
      : `${sourceText[value.start] === "'" ? "'" : '"'}${escapeForQuote(
          selection,
          sourceText[value.start] === "'" ? "'" : '"',
        )}${sourceText[value.start] === "'" ? "'" : '"'}`;
  let nextSource = sourceText.slice(0, value.start) + replacement + sourceText.slice(value.end);
  if (chatGptModelId !== undefined) {
    nextSource = ensureChatGptImport(nextSource);
  } else if (
    parseChatGptModelSelection(current) !== undefined &&
    !/\bchatgpt\s*\(/u.test(nextSource)
  ) {
    nextSource = removeChatGptImport(nextSource);
  }
  return { kind: "applied", from: current, to: selection, nextSource };
}

function findModelValue(object: ObjectExpression): AstNode | undefined {
  for (const property of object.properties) {
    if (property.type !== "Property" || property.computed || !keyMatches(property.key, "model")) {
      continue;
    }
    return isAstNode(property.value) ? unwrapExpression(property.value) : undefined;
  }
  return undefined;
}

function currentSelection(value: AstNode): string | undefined {
  if (value.type === "Literal" && typeof value.value === "string") return value.value;
  if (value.type !== "CallExpression" || !isAstNode(value.callee)) return undefined;
  const callee = unwrapExpression(value.callee);
  if (callee.type !== "Identifier" || callee.name !== "chatgpt") return undefined;
  const argument = value.arguments?.[0];
  if (argument === undefined) return DEFAULT_CHATGPT_MODEL_SELECTION;
  if (!isAstNode(argument)) return undefined;
  const unwrapped = unwrapExpression(argument);
  if (unwrapped.type !== "Literal" || typeof unwrapped.value !== "string") return undefined;
  const modelId = normalizeChatGptModelId(unwrapped.value);
  return modelId === undefined ? undefined : `${CHATGPT_MODEL_SELECTION_PREFIX}${modelId}`;
}

function ensureChatGptImport(source: string): string {
  const existing = source.match(/import\s*\{([^}]*)\}\s*from\s*["']eve\/models\/openai["'];?/u);
  if (existing !== null) {
    const names = existing[1]!
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.includes("chatgpt")) return source;
    const replacement = `import { ${[...names, "chatgpt"].join(", ")} } from "eve/models/openai";`;
    return (
      source.slice(0, existing.index) +
      replacement +
      source.slice(existing.index! + existing[0].length)
    );
  }
  const imports = [...source.matchAll(/^import .*;\s*$/gmu)];
  const insertion = imports.at(-1);
  const offset = insertion === undefined ? 0 : insertion.index! + insertion[0].length;
  const prefix = offset === 0 ? "" : "\n";
  return `${source.slice(0, offset)}${prefix}import { chatgpt } from "eve/models/openai";${source.slice(offset)}`;
}

function removeChatGptImport(source: string): string {
  return source.replace(
    /import\s*\{([^}]*)\}\s*from\s*["']eve\/models\/openai["'];?\n?/u,
    (full, contents: string) => {
      const names = contents
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      const remaining = names.filter((name) => name !== "chatgpt");
      if (remaining.length === names.length) return full;
      return remaining.length === 0
        ? ""
        : `import { ${remaining.join(", ")} } from "eve/models/openai";\n`;
    },
  );
}
