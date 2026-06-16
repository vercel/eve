// Mirrors `agent/sandbox/sandbox.ts`: bootstrap writes the marker token into
// the workspace before the first tool run, so a `bash` cat of the marker path
// proves `defineSandbox({ bootstrap })` actually executed.
export const BOOTSTRAP_MARKER_PATH = "/workspace/smoke-marker.txt";
export const BOOTSTRAP_MARKER_TOKEN = "sandbox-bootstrap-ok-J3Q";
