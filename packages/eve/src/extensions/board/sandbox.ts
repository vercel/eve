import extension from "./extension/extension.ts";
import { defineBoardSandbox } from "./extension/lib/sandbox.ts";

export type {
  BoardPolicySandbox,
  BoardSandbox,
  BoardSandboxRenewOptions,
  BoardSandboxRulesOptions,
} from "./extension/lib/sandbox.ts";

/**
 * `vb` in a sandbox, acting on the board as the agent: bound to the `eve/extensions/board`
 * mount's config, or to `BOARD_URL` and the `"eve"` profile without a mount.
 */
export const boardSandbox = defineBoardSandbox(() => extension.config);
