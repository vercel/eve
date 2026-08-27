#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { findDurableContractRegressions } from "./durable-contract-regression.mjs";

const [basePath, candidatePath, extra] = process.argv.slice(2);
if (basePath === undefined || candidatePath === undefined || extra !== undefined) {
  throw new Error(
    "Usage: node scripts/check-durable-contract-regression.mjs <base-manifest> <candidate-manifest>",
  );
}

const [base, candidate] = await Promise.all(
  [basePath, candidatePath].map(async (path) => JSON.parse(await readFile(path, "utf8"))),
);
const regressions = findDurableContractRegressions(base, candidate);
if (regressions.length > 0) {
  throw new Error(`Durable contract regression gate failed:\n- ${regressions.join("\n- ")}`);
}

console.log("Durable contract regression gate passed.");
