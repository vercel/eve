import { InvalidArgumentError } from "#compiled/commander/index.js";

import { LOOP_KIND_ENV } from "#internal/loops/config.js";
import type { LoopKind } from "#internal/loops/contract.js";

export const LOOP_OPTION_DESCRIPTION =
  "Loop implementation: inline | workflow | temporal (experimental)";

export function parseLoopOption(value: string): LoopKind {
  if (value === "inline" || value === "workflow" || value === "temporal") return value;
  throw new InvalidArgumentError(
    `Expected "inline", "workflow", or "temporal", received "${value}".`,
  );
}

export function applyLoopSelection(loop: LoopKind | undefined): void {
  if (loop !== undefined) process.env[LOOP_KIND_ENV] = loop;
}
