import { defineAgent } from "eve";

const model = process.env.EVE_BENCH_MODEL;
if (model === undefined || model.length === 0) {
  throw new Error("EVE_BENCH_MODEL must be set by the eve-bench harness.");
}

export default defineAgent({
  model,
});
