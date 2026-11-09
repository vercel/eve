import { defineEvalConfig } from "eve/evals";

// A shell eval may start the session's first sandbox, which can take a while.
export default defineEvalConfig({ timeoutMs: 240_000 });
