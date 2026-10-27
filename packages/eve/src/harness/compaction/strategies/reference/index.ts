import { createHash } from "node:crypto";
import type { FilePart, ImagePart, TextPart, ToolResultPart } from "ai";

import type { CompactionContext, CompactionStrategy } from "#harness/compaction/strategy.js";
import { type HarnessModelMessage, validateHarnessModelMessages } from "#harness/messages.js";
import { readFileData } from "#internal/attachments/data.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

/** Where referenced content lives, relative to the workspace root. */
const REFERENCE_ROOT = ".eve/compaction";

export interface ReferenceCompactionOptions {
  /** Content at least this many UTF-8 bytes long moves into a file. Default 16 KiB. */
  readonly minBytes?: number;
  /** Characters of the original kept in the stub as a preview. Default 240. */
  readonly previewChars?: number;
}

type Content = string | readonly unknown[];
type ToolOutput = ToolResultPart["output"];

/**
 * Compacts without a model call: each large user text, inline file and tool
 * output moves into a content-addressed file in the sandbox and leaves a short
 * stub (path, size, preview) in the history. The model reads the file back with
 * its file tools when it needs the content.
 */
export function referenceCompaction(options: ReferenceCompactionOptions = {}): CompactionStrategy {
  const minBytes = options.minBytes ?? 16 * 1024;
  const previewChars = options.previewChars ?? 240;
  return {
    async compact(history, context) {
      const referencer = createReferencer(context, minBytes, previewChars);
      const result: HarnessModelMessage[] = [];
      for (const message of history) result.push(await referenceMessage(message, referencer));
      return validateHarnessModelMessages(result);
    },
  };
}

interface Referencer {
  text(text: string, extension: string): Promise<string>;
  bytes(bytes: Uint8Array, label: string, extension: string): Promise<string>;
  isLarge(text: string): boolean;
}

function createReferencer(
  context: CompactionContext,
  minBytes: number,
  previewChars: number,
): Referencer {
  let sandbox: Promise<SandboxSession | null> | undefined;
  const open = async () => {
    sandbox ??= context.openSandbox();
    const session = await sandbox;
    if (session === null) {
      throw new Error(
        "Reference compaction needs a sandbox to write content to, and none is available.",
      );
    }
    return session;
  };
  const write = async (content: Uint8Array, extension: string) => {
    const session = await open();
    const sha = createHash("sha256").update(content).digest("hex").slice(0, 16);
    const path = `${REFERENCE_ROOT}/${sha}${extension}`;
    await session.writeBinaryFile({ content, path, signal: context.abortSignal });
    return session.resolvePath(path);
  };
  return {
    isLarge: (text) => Buffer.byteLength(text) >= minBytes,
    async text(text, extension) {
      const bytes = Buffer.from(text, "utf8");
      const path = await write(bytes, extension);
      const preview = text.slice(0, previewChars).replace(/\s+/g, " ").trim();
      return `[Content moved to ${path} (${bytes.byteLength} bytes). Read it with the file tools if needed. Starts: "${preview}"]`;
    },
    async bytes(bytes, label, extension) {
      const path = await write(bytes, extension);
      return `[${label} moved to ${path} (${bytes.byteLength} bytes). Read it with the file tools if needed.]`;
    },
  };
}

async function referenceMessage(
  message: HarnessModelMessage,
  referencer: Referencer,
): Promise<HarnessModelMessage> {
  if (message.role === "user") {
    return { ...message, content: await referenceUserContent(message.content, referencer) };
  }
  if (message.role === "tool") {
    const content = await Promise.all(
      message.content.map(async (part) =>
        part.type === "tool-result"
          ? { ...part, output: await referenceToolOutput(part.output, referencer) }
          : part,
      ),
    );
    return { ...message, content } as HarnessModelMessage;
  }
  return message;
}

async function referenceUserContent(content: Content, referencer: Referencer): Promise<never> {
  if (typeof content === "string") {
    return (
      referencer.isLarge(content) ? await referencer.text(content, ".txt") : content
    ) as never;
  }
  return (await Promise.all(
    content.map(async (part) => {
      const typed = part as TextPart | FilePart | ImagePart;
      if (typed.type === "text" && referencer.isLarge(typed.text)) {
        return { ...typed, text: await referencer.text(typed.text, ".txt") };
      }
      if (typed.type === "file" || typed.type === "image") {
        const data = readFileData(typed.type === "file" ? typed.data : typed.image);
        if (data.kind === "bytes" && referencer.isLarge(data.bytes.toString("latin1"))) {
          const label = typed.type === "file" ? (typed.filename ?? "Attachment") : "Image";
          return {
            type: "text",
            text: await referencer.bytes(data.bytes, label, ""),
          } satisfies TextPart;
        }
      }
      return part;
    }),
  )) as never;
}

async function referenceToolOutput(
  output: ToolOutput,
  referencer: Referencer,
): Promise<ToolOutput> {
  switch (output.type) {
    case "text":
    case "error-text":
      return referencer.isLarge(output.value)
        ? { type: output.type, value: await referencer.text(output.value, ".txt") }
        : output;
    case "json":
    case "error-json": {
      const serialized = JSON.stringify(output.value) ?? "";
      return referencer.isLarge(serialized)
        ? { type: "text", value: await referencer.text(serialized, ".json") }
        : output;
    }
    default:
      return output;
  }
}
