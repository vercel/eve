import { parseArgs } from "node:util";

import { ROLLDOWN_STANDARD_CONDITION_NAMES } from "#internal/bundler/nitro-rolldown.js";

/** Keep authored evaluation and its immutable bundle on the same conditional exports. */
export function authoredModuleConditions(
  args: readonly string[] = process.execArgv,
  nodeOptions: string = process.env.NODE_OPTIONS ?? "",
): string[] {
  const { values } = parseArgs({
    args: [...splitNodeOptions(nodeOptions), ...args],
    allowPositionals: true,
    strict: false,
    options: { conditions: { type: "string", multiple: true, short: "C" } },
  });
  return [...new Set(["eve-source", ...(values.conditions ?? [])])].filter(
    (condition): condition is string =>
      typeof condition === "string" && !ROLLDOWN_STANDARD_CONDITION_NAMES.has(condition),
  );
}

function splitNodeOptions(source: string): string[] {
  const args: string[] = [];
  let argument = "";
  let quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (character === "\\" && quoted && index + 1 < source.length) {
      argument += source[++index];
    } else if (character === '"') {
      quoted = !quoted;
    } else if (/\s/.test(character) && !quoted) {
      if (argument.length > 0) args.push(argument);
      argument = "";
    } else {
      argument += character;
    }
  }
  if (argument.length > 0) args.push(argument);
  return args;
}
