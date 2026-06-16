import { join, relative } from "node:path";

import {
  applyWorkflowTransform,
  detectWorkflowPatterns,
} from "#internal/workflow-bundle/workflow-builders.js";

const WORKFLOW_TEST_OUTPUT_DIR = ".workflow-vitest";

interface Plugin {
  readonly name: string;
  readonly config?: () => unknown;
  readonly transform?: (code: string, id: string) => unknown;
}

/**
 * Vitest plugin that applies Workflow's client transform and installs the
 * package-local workflow test world.
 */
export function workflow(): Plugin[] {
  return [
    createWorkflowTransformPlugin(),
    {
      config() {
        return {
          test: {
            globalSetup: ["./test/setup/workflow-global-setup.ts"],
            setupFiles: ["./test/setup/workflow-setup.ts"],
          },
        };
      },
      name: "eve:workflow-vitest",
    },
  ];
}

function createWorkflowTransformPlugin(): Plugin {
  return {
    name: "eve:workflow-transform",
    async transform(code: string, id: string) {
      const normalizedId = id.replaceAll("\\", "/");

      if (
        normalizedId.includes(`/${WORKFLOW_TEST_OUTPUT_DIR}/`) ||
        normalizedId.includes("/node_modules/") ||
        !isJavaScriptLikePath(id)
      ) {
        return null;
      }

      const patterns = detectWorkflowPatterns(code);

      if (!patterns.hasUseStep && !patterns.hasUseWorkflow && !patterns.hasSerde) {
        return null;
      }

      const workingDir = process.cwd();
      const transformed = await applyWorkflowTransform(
        createRelativeTransformFilename(workingDir, id),
        code,
        "client",
        id,
        workingDir,
      );

      return {
        code: transformed.code,
        map: null,
      };
    },
  };
}

function createRelativeTransformFilename(workingDir: string, filePath: string): string {
  const normalizedWorkingDir = workingDir.replaceAll("\\", "/").replace(/\/$/, "");
  const normalizedFilepath = filePath.replaceAll("\\", "/");
  const lowerWorkingDir = normalizedWorkingDir.toLowerCase();
  const lowerFilepath = normalizedFilepath.toLowerCase();

  if (lowerFilepath.startsWith(`${lowerWorkingDir}/`)) {
    return normalizedFilepath.substring(normalizedWorkingDir.length + 1);
  }

  const relativePath = relative(workingDir, filePath).replaceAll("\\", "/");

  if (!relativePath.startsWith("../")) {
    return relativePath;
  }

  return relativePath
    .split("/")
    .filter((part) => part !== "..")
    .join("/");
}

function isJavaScriptLikePath(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/.test(path);
}

export function resolveWorkflowTestOutputDirectory(workingDir: string): string {
  return join(workingDir, WORKFLOW_TEST_OUTPUT_DIR);
}
