import assert from "node:assert/strict";
import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vitest";
import plugin from "@tools/oxlint/architecture/index.ts";
import { noForbiddenLayerImportsRule } from "@tools/oxlint/architecture/rules/no-forbidden-layer-imports.ts";

const tester = new RuleTester();
const repositoryRoot = "/repo";

test("exports the repository architecture rules", () => {
  assert.deepEqual(Object.keys(plugin.rules), ["no-forbidden-layer-imports"]);
});

tester.run(
  "local-architecture/no-forbidden-layer-imports",
  noForbiddenLayerImportsRule,
  {
    valid: [
      {
        code: 'import "@db/services/chats"; import "@shared/chat/schema";',
        cwd: repositoryRoot,
        filename: "/repo/agent/tool.ts",
      },
      {
        code: 'import "@web/components/ui/button"; import "@db";',
        cwd: repositoryRoot,
        filename: "/repo/app/page.tsx",
      },
      {
        code: 'import "@db/services/chats"; import "@shared/chat/schema";',
        cwd: repositoryRoot,
        filename: "/repo/web/trpc.ts",
      },
      {
        code: 'import "@db/services/chats";',
        cwd: repositoryRoot,
        filename: "/repo/proxy.ts",
      },
      {
        code: 'import "@agent/agent";',
        cwd: repositoryRoot,
        filename: "/repo/evals/agent/agent.eval.ts",
      },
    ],
    invalid: [
      {
        code: 'import "@web/browser/activity";',
        cwd: repositoryRoot,
        filename: "/repo/agent/tool.ts",
        errors: [{ messageId: "forbiddenImport" }],
      },
      {
        code: 'import value from "../agent/value"; void value;',
        cwd: repositoryRoot,
        filename: "/repo/db/service.ts",
        errors: [{ messageId: "forbiddenImport" }],
      },
      {
        code: 'export { tool } from "@agent/tool";',
        cwd: repositoryRoot,
        filename: "/repo/app/page.tsx",
        errors: [{ messageId: "forbiddenImport" }],
      },
      {
        code: 'void import("@db/services/chats");',
        cwd: repositoryRoot,
        filename: "/repo/shared/chat/schema.ts",
        errors: [{ messageId: "forbiddenImport" }],
      },
      {
        code: 'vi.mock("@agent/agent");',
        cwd: repositoryRoot,
        filename: "/repo/web/auth/auth.test.ts",
        errors: [{ messageId: "forbiddenImport" }],
      },
      {
        code: 'vi.doMock("@shared/../agent/agent");',
        cwd: repositoryRoot,
        filename: "/repo/app/page.test.ts",
        errors: [{ messageId: "forbiddenImport" }],
      },
      {
        code: 'import "@shared//../agent/agent";',
        cwd: repositoryRoot,
        filename: "/repo/app/page.ts",
        errors: [{ messageId: "forbiddenImport" }],
      },
      {
        code: 'jest.unstable_mockModule("@web/../agent/agent", () => ({}));',
        cwd: repositoryRoot,
        filename: "/repo/db/service.test.ts",
        errors: [{ messageId: "forbiddenImport" }],
      },
      {
        code: 'import "@agent/agent";',
        cwd: repositoryRoot,
        filename: "/repo/proxy.ts",
        errors: [{ messageId: "forbiddenImport" }],
      },
    ],
  }
);
