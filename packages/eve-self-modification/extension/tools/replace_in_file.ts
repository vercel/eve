import { defineTool } from "eve/tools";

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    filePath: {
      type: "string",
      minLength: 1,
      description: "Absolute path to the text file to edit.",
    },
    oldText: {
      type: "string",
      minLength: 1,
      description: "Exact text that must occur exactly once in the current file.",
    },
    newText: {
      type: "string",
      description: "Replacement text. Use an empty string to delete oldText.",
    },
  },
  required: ["filePath", "oldText", "newText"],
} as const;

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    replacements: { type: "integer", const: 1 },
  },
  required: ["path", "replacements"],
} as const;

/** Replaces one uniquely matching text fragment in a file. */
export function replaceExactlyOnce(content: string, oldText: string, newText: string): string {
  if (oldText.length === 0) {
    throw new Error("oldText must not be empty.");
  }

  const firstMatch = content.indexOf(oldText);
  if (firstMatch === -1) {
    throw new Error("oldText was not found in the current file. Read the file and try again.");
  }

  if (content.indexOf(oldText, firstMatch + oldText.length) !== -1) {
    throw new Error(
      "oldText occurs more than once. Include more surrounding text to make it unique.",
    );
  }

  return content.slice(0, firstMatch) + newText + content.slice(firstMatch + oldText.length);
}

export default defineTool({
  description:
    "Replace one exact, uniquely matching text fragment in an existing source file. " +
    "Read the file first, then copy enough surrounding text into oldText to make the match unique. " +
    "Prefer this over rewriting a complete existing file with write_file.",
  inputSchema,
  outputSchema,
  async execute(input, ctx) {
    const { filePath, newText, oldText } = input;
    if (
      typeof filePath !== "string" ||
      typeof newText !== "string" ||
      typeof oldText !== "string"
    ) {
      throw new Error("filePath, oldText, and newText must be strings.");
    }

    const sandbox = await ctx.getSandbox();
    const content = await sandbox.readTextFile({ path: filePath });

    if (content === null) {
      throw new Error(`File not found: ${filePath}.`);
    }
    if (content.includes("\0")) {
      throw new Error(`File "${filePath}" contains NUL bytes and appears to be binary.`);
    }

    await sandbox.writeTextFile({
      content: replaceExactlyOnce(content, oldText, newText),
      path: filePath,
    });

    return { path: sandbox.resolvePath(filePath), replacements: 1 as const };
  },
});
