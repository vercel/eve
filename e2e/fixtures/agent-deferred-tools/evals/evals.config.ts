import { defineEvalConfig } from "eve/evals";

// Workflow tools and the cache eval dispatch durable runs; serialize so none is starved.
export default defineEvalConfig({ maxConcurrency: 1, timeoutMs: 240_000 });
