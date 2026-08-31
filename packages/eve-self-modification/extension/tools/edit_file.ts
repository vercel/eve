import { defineTool } from "eve/tools";

const replacementSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    oldText: {
      type: "string",
      minLength: 1,
      description:
        "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
    },
    newText: {
      type: "string",
      description: "Replacement text for this targeted edit.",
    },
  },
  required: ["oldText", "newText"],
} as const;

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description: "Path to the file to edit (relative or absolute).",
    },
    edits: {
      type: "array",
      minItems: 1,
      items: replacementSchema,
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
    },
  },
  required: ["path", "edits"],
} as const;

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    replacements: { type: "integer", minimum: 1 },
  },
  required: ["path", "replacements"],
} as const;

interface ExactEdit {
  readonly oldText: string;
  readonly newText: string;
}

/** Applies unique, non-overlapping replacements matched against the original content. */
export function applyExactEdits(content: string, edits: readonly ExactEdit[]): string {
  if (edits.length === 0) {
    throw new Error("edits must contain at least one replacement.");
  }

  const matches = edits.map((edit, index) => {
    if (edit.oldText.length === 0) {
      throw new Error(`edits[${index}].oldText must not be empty.`);
    }

    const start = content.indexOf(edit.oldText);
    if (start === -1) {
      throw new Error(
        `edits[${index}].oldText was not found in the current file. Read the file and try again.`,
      );
    }
    if (content.indexOf(edit.oldText, start + 1) !== -1) {
      throw new Error(
        `edits[${index}].oldText occurs more than once. Include more surrounding text to make it unique.`,
      );
    }

    return { ...edit, end: start + edit.oldText.length, index, start };
  });

  const orderedMatches = [...matches].sort((left, right) => left.start - right.start);
  for (let index = 1; index < orderedMatches.length; index += 1) {
    const previous = orderedMatches[index - 1];
    const current = orderedMatches[index];
    if (previous !== undefined && current !== undefined && current.start < previous.end) {
      throw new Error(
        `edits[${previous.index}] and edits[${current.index}] overlap. Merge them into one edit.`,
      );
    }
  }

  return orderedMatches
    .toReversed()
    .reduce(
      (result, edit) => result.slice(0, edit.start) + edit.newText + result.slice(edit.end),
      content,
    );
}

export default defineTool({
  description:
    "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
  inputSchema,
  outputSchema,
  async execute(input, ctx) {
    const { edits, path } = input;
    if (
      typeof path !== "string" ||
      !Array.isArray(edits) ||
      edits.some(
        (edit) =>
          typeof edit !== "object" ||
          edit === null ||
          typeof edit.oldText !== "string" ||
          typeof edit.newText !== "string",
      )
    ) {
      throw new Error("path must be a string and edits must contain oldText and newText strings.");
    }

    const sandbox = await ctx.getSandbox();
    const content = await sandbox.readTextFile({ path });

    if (content === null) {
      throw new Error(`File not found: ${path}.`);
    }
    if (content.includes("\0")) {
      throw new Error(`File "${path}" contains NUL bytes and appears to be binary.`);
    }

    await sandbox.writeTextFile({
      content: applyExactEdits(content, edits),
      path,
    });

    return { path: sandbox.resolvePath(path), replacements: edits.length };
  },
});
