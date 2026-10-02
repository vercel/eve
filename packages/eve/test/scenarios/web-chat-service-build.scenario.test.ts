import { exec, execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createFakePrompter } from "../../src/internal/testing/fake-prompter.js";
import {
  resolveScenarioPackageVersion,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { headlessAsker } from "../../src/setup/ask.js";
import { applyWebSetup } from "../../src/setup/integrations/web/setup.js";
import { integrationSetupEnvironment } from "../../src/setup/integrations/shared/environment.js";
import { createSetupContexts } from "../../src/setup/integrations/shared/ui.js";

const scenarioApp = useScenarioApp();
const require = createRequire(import.meta.url);
const runFile = promisify(execFile);
const runCommand = promisify(exec);

it("builds the generated Web Chat service with pnpm dependencies installed only at the root", async () => {
  const { appRoot } = await scenarioApp({
    name: "web-chat-service-build",
    installDependencies: true,
    dependencies: {
      next: await resolveScenarioPackageVersion("next"),
      react: await resolveScenarioPackageVersion("react"),
      "react-dom": await resolveScenarioPackageVersion("react-dom"),
      typescript: await resolveScenarioPackageVersion("typescript"),
      "@types/node": require("@types/node/package.json").version,
      "@types/react": require("@types/react/package.json").version,
    },
    files: {
      "agent/agent.ts":
        'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });\n',
      "apps/web/app/layout.jsx":
        "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n",
      "apps/web/app/page.jsx":
        "export default function Page() { return <main>Web Chat service</main>; }\n",
    },
  });
  const contexts = createSetupContexts({
    appRoot,
    asker: headlessAsker(),
    environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
    resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
  });
  await applyWebSetup({ hosting: "vercel", packageManager: "pnpm" }, contexts.apply);
  const configured = await runFile(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'const { default: config } = await import("./vercel.ts"); console.log(JSON.stringify(config.services.web));',
    ],
    { cwd: appRoot },
  );
  const webService = JSON.parse(configured.stdout) as { root: string; buildCommand?: string };
  const webRoot = join(appRoot, webService.root);
  // Vercel synthesizes this nested package when no app manifest/build command exists.
  await writeFile(
    join(webRoot, "package.json"),
    JSON.stringify({ scripts: { "vercel-build": "next build" } }),
  );
  const command = webService.buildCommand ?? "pnpm run vercel-build";

  await runCommand(command, {
    cwd: webRoot,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      // The test runner's workspace executables must not mask a missing app binary.
      PATH: process.env.PATH?.split(delimiter)
        .filter((entry) => !entry.includes("node_modules"))
        .join(delimiter),
    },
    maxBuffer: 10 * 1024 * 1024,
  });

  const manifest = JSON.parse(
    await readFile(join(webRoot, ".next", "prerender-manifest.json"), "utf8"),
  );
  expect(manifest.routes["/"]).toBeDefined();
}, 120_000);
