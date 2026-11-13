import { z } from "zod";

import type { JsonValue } from "../json";
/**
 * Block-addressed RichText patches, so large page bodies can be edited without
 * resupplying the whole document.
 *
 * @packageDocumentation
 */
import { isObject, isString } from "../values";
import { isRichTextDocument, richTextBlockHash } from "./content";
import { updateFieldIdSchema } from "./input-schemas";

const blockIndexSchema = z.number().int().min(0).max(10_000);
const blockHashSchema = z
  .string()
  .regex(/^[0-9a-f]{12}$/u, "Use the 12-character block hash from the read.");
const blockNodesSchema = z.array(z.json()).max(100);

const richTextEditSchema = z.discriminatedUnion("type", [
  z
    .object({
      find: z.string().min(1).max(10_000),
      hash: blockHashSchema,
      index: blockIndexSchema,
      replace: z.string().max(10_000),
      type: z.literal("replaceText"),
    })
    .strict(),
  z
    .object({
      hashes: z.array(blockHashSchema).min(1).max(100),
      index: blockIndexSchema,
      nodes: blockNodesSchema,
      type: z.literal("replaceBlocks"),
    })
    .strict(),
  z
    .object({
      afterHash: blockHashSchema.nullable(),
      afterIndex: blockIndexSchema.nullable(),
      nodes: blockNodesSchema.min(1),
      type: z.literal("insertBlocks"),
    })
    .strict()
    .refine(
      ({ afterHash, afterIndex }) =>
        (afterHash === null) === (afterIndex === null),
      "Use afterIndex and afterHash together, or both null to insert at the start."
    ),
]);

/* The value of a patch operation in update_contentful_fields. */
const richTextPatchSchema = z
  .object({
    edits: z.array(richTextEditSchema).min(1).max(50),
    embeds: z.array(updateFieldIdSchema).max(1000).nullable(),
  })
  .strict();

type RichTextPatch = z.infer<typeof richTextPatchSchema>;
type RichTextEdit = RichTextPatch["edits"][number];

interface Node {
  content?: JsonValue[];
  data?: { target?: { sys?: { id?: JsonValue } } };
  nodeType?: JsonValue;
  value?: JsonValue;
}

const EMBED_NODES = new Set([
  "embedded-asset-block",
  "embedded-entry-block",
  "embedded-entry-inline",
]);

const isNode = (value: unknown): value is Node =>
  value !== null && isObject(value) && !Array.isArray(value);

/* Visit nodes in document order without recursion. */
const walk = function* walk(root: JsonValue): Generator<Node> {
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    if (!isNode(node)) {
      continue;
    }
    visited += 1;
    if (visited > 100_000) {
      throw new Error("RichText document is too large to patch.");
    }
    yield node;
    if (Array.isArray(node.content)) {
      for (let index = node.content.length - 1; index >= 0; index -= 1) {
        pending.push(node.content[index]);
      }
    }
  }
};

/* Embedded entry and asset IDs, in document order. */
const embedIds = (document: JsonValue): string[] => {
  const ids: string[] = [];
  for (const node of walk(document)) {
    const id = node.data?.target?.sys?.id;
    if (
      isString(node.nodeType) &&
      EMBED_NODES.has(node.nodeType) &&
      isString(id)
    ) {
      ids.push(id);
    }
  }
  return ids;
};

type TextEdit = Extract<RichTextEdit, { type: "replaceText" }>;

const occurrences = (text: string, find: string): number[] => {
  const starts: number[] = [];
  for (
    let position = text.indexOf(find);
    position >= 0;
    position = text.indexOf(find, position + find.length)
  ) {
    starts.push(position);
  }
  return starts;
};

/* Find the one occurrence of an edit's text within a single text run of the block as read. */
const locate = (texts: (Node & { value: string })[], edit: TextEdit) => {
  const matches = texts.flatMap((node) =>
    occurrences(node.value, edit.find).map((start) => ({
      end: start + edit.find.length,
      node,
      replace: edit.replace,
      start,
    }))
  );
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(
      `Block ${edit.index}: find text appears ${matches.length} times. Include more surrounding text so it matches once.`
    );
  }
  if (
    texts
      .map(({ value }) => value)
      .join("")
      .includes(edit.find)
  ) {
    throw new Error(
      `Block ${edit.index}: find text crosses a formatting or link boundary. Use replaceBlocks with the block's raw JSON.`
    );
  }
  throw new Error(`Block ${edit.index}: find text was not found.`);
};

/**
 * Applies nonoverlapping text edits to a cloned block using matches from its original text.
 *
 * @param block - Previously read rich-text block to clone and edit.
 * @param edits - Text substitutions bound to the original block and leaf boundaries.
 * @returns A cloned block containing the substitutions, with other nodes and marks preserved.
 * @throws {@link Error} When a match is missing, ambiguous, overlapping, or crosses a formatting boundary.
 */
const replaceTexts = (block: JsonValue, edits: TextEdit[]): JsonValue => {
  const clone = structuredClone(block);
  const texts = [...walk(clone)].filter(
    (node): node is Node & { value: string } =>
      node.nodeType === "text" && isString(node.value)
  );
  const located = edits
    .map((edit) => locate(texts, edit))
    .toSorted((a, b) =>
      a.node === b.node
        ? b.start - a.start
        : texts.indexOf(a.node) - texts.indexOf(b.node)
    );
  for (const [index, match] of located.entries()) {
    const next = located[index - 1];
    if (next?.node === match.node && match.end > next.start) {
      throw new Error(
        `Block ${edits[0].index}: two replaceText edits overlap. Combine them into one edit.`
      );
    }
  }
  for (const { end, node, replace, start } of located) {
    node.value = node.value.slice(0, start) + replace + node.value.slice(end);
  }
  return clone;
};

const parsePatch = (value: JsonValue): RichTextPatch => {
  const result = richTextPatchSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid RichText patch: ${result.error.message}`);
  }
  return result.data;
};

/* Edits resolved against the document as read, before the result is assembled. */
class PatchPlan {
  readonly edited = new Map<number, TextEdit[]>();
  readonly inserted = new Map<number, JsonValue[]>();
  readonly replaced = new Map<number, { count: number; nodes: JsonValue[] }>();
  private readonly claimed = new Set<number>();
  private readonly blocks: JsonValue[];

  constructor(blocks: JsonValue[]) {
    this.blocks = blocks;
  }

  /* Require the addressed block to be the one the model read. */
  private confirm(index: number, hash: string) {
    if (index >= this.blocks.length) {
      throw new Error(
        `Block ${index} does not exist; the document has ${this.blocks.length} blocks.`
      );
    }
    if (richTextBlockHash(this.blocks[index]) !== hash) {
      throw new Error(
        `Block ${index} does not match its hash. Read the entry again and use the current block indexes and hashes.`
      );
    }
  }

  private claim(index: number) {
    if (this.claimed.has(index)) {
      throw new Error(`More than one replacement targets block ${index}.`);
    }
    this.claimed.add(index);
  }

  add(edit: RichTextEdit) {
    if (edit.type === "replaceText") {
      this.confirm(edit.index, edit.hash);
      const edits = this.edited.get(edit.index);
      if (edits) {
        edits.push(edit);
      } else {
        this.claim(edit.index);
        this.edited.set(edit.index, [edit]);
      }
      return;
    }
    if (edit.type === "replaceBlocks") {
      for (const [offset, hash] of edit.hashes.entries()) {
        this.confirm(edit.index + offset, hash);
        this.claim(edit.index + offset);
      }
      this.replaced.set(edit.index, {
        count: edit.hashes.length,
        nodes: edit.nodes,
      });
      return;
    }
    if (edit.afterIndex !== null && edit.afterHash !== null) {
      this.confirm(edit.afterIndex, edit.afterHash);
    }
    const position = edit.afterIndex === null ? 0 : edit.afterIndex + 1;
    if (this.inserted.has(position)) {
      throw new Error(
        `More than one insertion targets position ${position}. Combine them into one insertBlocks edit.`
      );
    }
    this.inserted.set(position, edit.nodes);
  }

  /* Build the patched block list; insertions inside a replaced range are rejected. */
  assemble(): JsonValue[] {
    for (const [start, { count }] of this.replaced) {
      for (const position of this.inserted.keys()) {
        if (position > start && position < start + count) {
          throw new Error(
            `An insertion falls inside the replaced blocks ${start} to ${start + count - 1}. Put those nodes in the replacement instead.`
          );
        }
      }
    }
    const content: JsonValue[] = [];
    for (let index = 0; index <= this.blocks.length; index += 1) {
      content.push(...(this.inserted.get(index) ?? []));
      const replacement = this.replaced.get(index);
      if (replacement) {
        content.push(...replacement.nodes);
        index += replacement.count - 1;
      } else if (index < this.blocks.length) {
        const edits = this.edited.get(index);
        content.push(
          edits ? replaceTexts(this.blocks[index], edits) : this.blocks[index]
        );
      }
    }
    return content;
  }
}

/* Reject embed changes the patch did not confirm with a complete embeds list. */
const checkEmbeds = (
  before: JsonValue,
  after: JsonValue,
  embeds: RichTextPatch["embeds"]
) => {
  const previous = embedIds(before);
  const actual = embedIds(after);
  const expected = embeds ?? previous;
  if (actual.join(",") === expected.join(",")) {
    return;
  }
  throw new Error(
    embeds === null
      ? `This patch adds, removes, or reorders embeds (before: [${previous.join(", ")}], after: [${actual.join(", ")}]). Confirm the change by setting embeds to the complete ordered list of embedded IDs after the patch.`
      : `Embeds after the patch ([${actual.join(", ")}]) do not match the embeds list ([${expected.join(", ")}]).`
  );
};

/**
 * Apply a block-addressed patch to a RichText field's current document.
 *
 * @param current - The field's current configured-locale value; undefined patches an empty document.
 * @param value - Patch with edits addressed to block indexes and hashes from one read.
 * @returns The complete patched document. Document and model validation happen separately.
 * @throws {@link Error} If the patch is malformed, a block hash no longer matches, edits overlap, or
 * embeds change without a matching embeds list.
 * @remarks Every edit addresses the document as read, not the result of earlier edits.
 * Blocks outside the edits are kept unchanged.
 */
export const applyRichTextPatch = (
  current: JsonValue,
  value: JsonValue
): z.core.util.JSONType => {
  const patch = parsePatch(value);
  const document =
    current === undefined
      ? { content: [], data: {}, nodeType: "document" }
      : current;
  if (!isRichTextDocument(document)) {
    throw new Error("The field does not contain a RichText document to patch.");
  }
  const plan = new PatchPlan(document.content);
  for (const edit of patch.edits) {
    plan.add(edit);
  }
  const result = { ...document, content: plan.assemble() };
  checkEmbeds(document, result, patch.embeds);
  // CMA documents are JSON; parsing narrows the patched value to the write type.
  return z.json().parse(result);
};

/**
 * Builds a document containing only nodes introduced by a rich-text patch.
 *
 * @param value - Patch input validated against the patch schema.
 * @returns Inserted and replacement blocks wrapped in a document for reference validation.
 * @remarks Text replacements cannot introduce references, so existing blocks are excluded from per-write link checks.
 */
export const richTextPatchInsertions = (
  value: JsonValue
): z.core.util.JSONType => {
  const patch = parsePatch(value);
  return {
    content: patch.edits.flatMap((edit) =>
      edit.type === "replaceText" ? [] : edit.nodes
    ),
    data: {},
    nodeType: "document",
  };
};
