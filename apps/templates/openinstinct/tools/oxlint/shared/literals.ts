import { z } from "zod";

import type { ESTree } from "@oxlint/plugins";

const stringLiteralValueSchema = z.string();

/** Narrow an AST node to a string literal by parsing its literal value. */
export const isStringLiteral = (
  node: ESTree.Node
): node is ESTree.StringLiteral =>
  node.type === "Literal" &&
  stringLiteralValueSchema.safeParse(node.value).success;
