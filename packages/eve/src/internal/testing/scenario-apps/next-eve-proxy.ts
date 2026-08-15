import { createRequire } from "node:module";

import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

const require = createRequire(import.meta.url);

export interface NextEveProxyDescriptorOptions {
  readonly installDependencies?: boolean;
  readonly vercelVersion?: string;
}

/**
 * A Next.js host with routing middleware and a generated eve service.
 */
export function createNextEveProxyDescriptor(
  options: NextEveProxyDescriptorOptions = {},
): ScenarioAppDescriptor {
  const dependencies: Record<string, string> = {
    next: resolveInstalledPackageVersion("next"),
    react: resolveInstalledPackageVersion("react"),
    "react-dom": resolveInstalledPackageVersion("react-dom"),
  };
  if (options.vercelVersion !== undefined) {
    dependencies.vercel = options.vercelVersion;
  }

  return {
    dependencies,
    files: {
      "agent/agent.mjs": `import { defineAgent } from "eve";

export default defineAgent({ model: "openai/gpt-5.4" });
`,
      "agent/instructions.md": "You are a test agent.\n",
      "next.config.mjs": `import { withEve } from "eve/next";

export default withEve({});
`,
      "pnpm-workspace.yaml": "minimumReleaseAge: 0\n",
      "src/app/layout.js": `export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}
`,
      "src/app/page.js": `export default function Page() {
  return <main>eve middleware deployment</main>;
}
`,
      "src/proxy.js": `import { NextResponse } from "next/server";

export function proxy() {
  return NextResponse.next();
}
`,
    },
    installDependencies: options.installDependencies,
    name: "next-eve-proxy",
  };
}

function resolveInstalledPackageVersion(packageName: string): string {
  const manifest: unknown = require(`${packageName}/package.json`);

  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  ) {
    throw new Error(`Expected ${packageName}/package.json to contain a string version.`);
  }

  return manifest.version;
}
