// Mirrors `agent/sandbox/sandbox.ts` and `agent/sandbox/workspace/`: each
// constant is a token (or path) the sandbox lifecycle writes so an eval can
// prove the corresponding surface actually ran. Kept in sync by hand because
// the agent tree is compiled/deployed independently of the eval tree.

/** Written by `bootstrap` into the reusable template snapshot. */
export const BOOTSTRAP_MARKER_PATH = "/workspace/smoke-marker.txt";
export const BOOTSTRAP_MARKER_TOKEN = "sandbox-bootstrap-ok-J3Q";

/** Custom CLI installed on the PATH by `bootstrap`. */
export const SANDBOX_CLI_NAME = "eve-greet";
export const SANDBOX_CLI_TOKEN = "eve-greet-cli-ok-R7M";

/** Written by `onSession` into each live session (not the template). */
export const SESSION_MARKER_PATH = "/workspace/session-marker.txt";
export const SESSION_MARKER_TOKEN = "sandbox-onsession-ok-X5T";

/** Loopback endpoint that holds each curl request long enough to measure overlap. */
export const FANOUT_DELAY_SERVER_URL = "http://127.0.0.1:43100/delay";

/** Mounted from `agent/sandbox/workspace/seed-data.txt` at session start. */
export const WORKSPACE_SEED_PATH = "/workspace/seed-data.txt";
export const WORKSPACE_SEED_TOKEN = "sandbox-workspace-seed-ok-Z9W";
