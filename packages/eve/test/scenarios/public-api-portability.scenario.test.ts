import { execFile } from "node:child_process";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, it } from "vitest";

import type { ScenarioAppDescriptor } from "../../src/internal/testing/scenario-app.js";
import {
  EVE_ROUTE_PORTABILITY_DESCRIPTOR,
  DISCORD_ROUTE_PORTABILITY_DESCRIPTOR,
  GITHUB_ROUTE_PORTABILITY_DESCRIPTOR,
  SLACK_ROUTE_PORTABILITY_DESCRIPTOR,
  TEAMS_ROUTE_PORTABILITY_DESCRIPTOR,
  TELEGRAM_ROUTE_PORTABILITY_DESCRIPTOR,
  TWILIO_ROUTE_PORTABILITY_DESCRIPTOR,
} from "../../src/internal/testing/scenario-apps/index.js";
import { useTemporaryDirectories } from "../../src/internal/testing/use-temporary-app-roots.js";

const runFile = promisify(execFile);
const createScratchDirectory = useTemporaryDirectories();
const EVE_PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const ROOT_TYPE_DEFINITIONS = fileURLToPath(
  new URL("../../../../node_modules/@types", import.meta.url),
);
const TSC_BIN_PATH = fileURLToPath(
  new URL("../../../../node_modules/typescript/bin/tsc", import.meta.url),
);
const COMPILED_VENDOR_TYPES = join(EVE_PACKAGE_ROOT, ".generated", "compiled");
const PORTABILITY_TEST_TIMEOUT_MS = 30_000;

interface PortabilityCase {
  readonly descriptor: ScenarioAppDescriptor;
  readonly include: readonly string[];
  readonly name: string;
  readonly packageExports: Record<string, { readonly types: string }>;
}

const PORTABILITY_CASES: readonly PortabilityCase[] = [
  {
    descriptor: {
      files: {
        "agent/sandbox.ts": `import { defaultBackend, defineSandbox } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";
import { justbash } from "eve/sandbox/just-bash";
import { microsandbox } from "eve/sandbox/microsandbox";
import { vercel } from "eve/sandbox/vercel";

const fallback = defaultBackend({
  docker: { image: "ghcr.io/vercel/eve:latest" },
  justBash: {},
  microsandbox: {},
  vercel: { resources: { vcpus: 2 } },
});

void docker;
void justbash;
void microsandbox;

export default defineSandbox({
  backend: process.env.VERCEL === "1" ? vercel() : fallback,
});
`,
      },
      name: "sandbox-public-api-portability",
    },
    include: [
      "src/public/sandbox/index.ts",
      "src/public/sandbox/docker.ts",
      "src/public/sandbox/just-bash.ts",
      "src/public/sandbox/microsandbox.ts",
      "src/public/sandbox/vercel.ts",
    ],
    name: "lets tsc typecheck sandbox backend factories from nested subpath imports",
    packageExports: {
      "./sandbox": {
        types: "./dist/src/public/sandbox/index.d.ts",
      },
      "./sandbox/docker": {
        types: "./dist/src/public/sandbox/docker.d.ts",
      },
      "./sandbox/just-bash": {
        types: "./dist/src/public/sandbox/just-bash.d.ts",
      },
      "./sandbox/microsandbox": {
        types: "./dist/src/public/sandbox/microsandbox.d.ts",
      },
      "./sandbox/vercel": {
        types: "./dist/src/public/sandbox/vercel.d.ts",
      },
    },
  },
  {
    descriptor: SLACK_ROUTE_PORTABILITY_DESCRIPTOR,
    include: ["src/public/channels/slack/index.ts", "src/public/definitions/channel.ts"],
    name: "lets tsc typecheck a default-exported slackChannel without extra annotations",
    packageExports: {
      "./channels/slack": {
        types: "./dist/src/public/channels/slack/index.d.ts",
      },
    },
  },
  {
    descriptor: DISCORD_ROUTE_PORTABILITY_DESCRIPTOR,
    include: ["src/public/channels/discord/index.ts", "src/public/definitions/channel.ts"],
    name: "lets tsc typecheck a default-exported discordChannel without extra annotations",
    packageExports: {
      "./channels/discord": {
        types: "./dist/src/public/channels/discord/index.d.ts",
      },
    },
  },
  {
    descriptor: GITHUB_ROUTE_PORTABILITY_DESCRIPTOR,
    include: ["src/public/channels/github/index.ts", "src/public/definitions/channel.ts"],
    name: "lets tsc typecheck a default-exported githubChannel without extra annotations",
    packageExports: {
      "./channels/github": {
        types: "./dist/src/public/channels/github/index.d.ts",
      },
    },
  },
  {
    descriptor: TWILIO_ROUTE_PORTABILITY_DESCRIPTOR,
    include: ["src/public/channels/twilio/index.ts", "src/public/definitions/channel.ts"],
    name: "lets tsc typecheck a default-exported twilioChannel without extra annotations",
    packageExports: {
      "./channels/twilio": {
        types: "./dist/src/public/channels/twilio/index.d.ts",
      },
    },
  },
  {
    descriptor: TEAMS_ROUTE_PORTABILITY_DESCRIPTOR,
    include: ["src/public/channels/teams/index.ts", "src/public/definitions/channel.ts"],
    name: "lets tsc typecheck a default-exported teamsChannel without extra annotations",
    packageExports: {
      "./channels/teams": {
        types: "./dist/src/public/channels/teams/index.d.ts",
      },
    },
  },
  {
    descriptor: TELEGRAM_ROUTE_PORTABILITY_DESCRIPTOR,
    include: ["src/public/channels/telegram/index.ts", "src/public/definitions/channel.ts"],
    name: "lets tsc typecheck a default-exported telegramChannel without extra annotations",
    packageExports: {
      "./channels/telegram": {
        types: "./dist/src/public/channels/telegram/index.d.ts",
      },
    },
  },
  {
    descriptor: EVE_ROUTE_PORTABILITY_DESCRIPTOR,
    include: ["src/public/channels/auth.ts", "src/public/channels/eve.ts"],
    name: "lets tsc typecheck a default-exported eveChannel without extra annotations",
    packageExports: {
      "./channels/auth": {
        types: "./dist/src/public/channels/auth.d.ts",
      },
      "./channels/eve": {
        types: "./dist/src/public/channels/eve.d.ts",
      },
    },
  },
];

describe("public API declaration portability", () => {
  for (const testCase of PORTABILITY_CASES) {
    it(
      testCase.name,
      async () => {
        await expectPortableFixtureToTypecheck(testCase);
      },
      PORTABILITY_TEST_TIMEOUT_MS,
    );
  }
});

async function expectPortableFixtureToTypecheck(testCase: PortabilityCase): Promise<void> {
  const scratchRoot = await createScratchDirectory("eve-public-api-portability-");
  const emittedPackageRoot = join(scratchRoot, "eve");
  const appRoot = join(scratchRoot, "app");
  const emitTsconfigPath = join(scratchRoot, "tsconfig.emit.json");
  const consumerTsconfigPath = join(appRoot, "tsconfig.json");

  await mkdir(emittedPackageRoot, { recursive: true });
  await writeFile(
    join(emittedPackageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "eve",
        type: "module",
        imports: {
          "#compiled/*": "./dist/compiled/*",
          "#*.js": "./dist/src/*.js",
        },
        exports: testCase.packageExports,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    emitTsconfigPath,
    `${JSON.stringify(
      {
        extends: join(EVE_PACKAGE_ROOT, "tsconfig.json"),
        compilerOptions: {
          declaration: true,
          declarationMap: false,
          emitDeclarationOnly: true,
          noEmit: false,
          noEmitOnError: true,
          outDir: join(emittedPackageRoot, "dist"),
          rootDir: EVE_PACKAGE_ROOT,
          typeRoots: [ROOT_TYPE_DEFINITIONS],
        },
        include: testCase.include.map((path) => join(EVE_PACKAGE_ROOT, path)),
      },
      null,
      2,
    )}\n`,
  );

  await runFile(process.execPath, [TSC_BIN_PATH, "-p", emitTsconfigPath], {
    cwd: REPO_ROOT,
  });

  await copyCompiledVendorTypes(join(emittedPackageRoot, "dist", "compiled"));

  await mkdir(appRoot, { recursive: true });
  await writeDescriptorAppFiles({
    appRoot,
    descriptor: testCase.descriptor,
  });
  await mkdir(join(appRoot, "node_modules"), { recursive: true });
  await cp(emittedPackageRoot, join(appRoot, "node_modules", "eve"), {
    recursive: true,
  });
  await writeFile(
    join(appRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "public-api-portability-consumer",
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    consumerTsconfigPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          allowImportingTsExtensions: true,
          declaration: true,
          esModuleInterop: true,
          forceConsistentCasingInFileNames: true,
          lib: ["ES2024"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          outDir: "dist",
          rootDir: ".",
          skipLibCheck: true,
          strict: true,
          target: "ES2024",
          typeRoots: [ROOT_TYPE_DEFINITIONS],
          types: ["node"],
          verbatimModuleSyntax: true,
        },
        include: ["agent/**/*.ts"],
      },
      null,
      2,
    )}\n`,
  );

  await runFile(process.execPath, [TSC_BIN_PATH, "-p", consumerTsconfigPath], {
    cwd: appRoot,
  });
}

async function writeDescriptorAppFiles(input: {
  readonly appRoot: string;
  readonly descriptor: ScenarioAppDescriptor;
}): Promise<void> {
  for (const [relativePath, contents] of Object.entries(input.descriptor.files)) {
    const destinationPath = join(input.appRoot, relativePath);
    await mkdir(dirname(destinationPath), {
      recursive: true,
    });
    await writeFile(destinationPath, contents, "utf8");
  }
}

async function copyCompiledVendorTypes(destRoot: string): Promise<void> {
  await copyDtsRecursive(COMPILED_VENDOR_TYPES, destRoot);
}

async function copyDtsRecursive(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDtsRecursive(srcPath, destPath);
    } else if (entry.name.endsWith(".d.ts")) {
      await cp(srcPath, destPath);
    }
  }
}
