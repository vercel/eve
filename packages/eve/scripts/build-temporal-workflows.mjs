import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bundleWorkflowCode } from "@temporalio/worker";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(packageRoot, "dist/src/internal/loops/temporal/workflows-bundle.cjs");
const workflowsPath = resolve(packageRoot, "src/internal/loops/temporal/workflows.ts");

const bundle = await bundleWorkflowCode({ workflowsPath });
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, bundle.code);
