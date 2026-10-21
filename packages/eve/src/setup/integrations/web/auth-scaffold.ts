import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import { appendEnv } from "#setup/append-env.js";
import { writeTextFile } from "#setup/scaffold/files.js";
import { resolveVersionToken } from "#setup/scaffold/version-tokens.js";
import {
  WEB_APP_SIGN_IN_WITH_VERCEL_TEMPLATE_FILES,
  WEB_APP_TEMPLATE_FILES,
  WEB_CHANNEL_TEMPLATES,
} from "#setup/scaffold/create/web-template.js";
import { resolveWebPackageVersions } from "#setup/scaffold/update/web-options.js";

// Recognize only exact previously generated auth files; authored edits still require --overwrite.
const LEGACY_AUTH_HASHES = [
  // 35eb6705e: temporary OIDC bridge used by this preview PR.
  "6ea9dc7425e713c56611dbe1e97eb6cf5520c72f57eb7213d69bfcc76b22fcbc",
  // ed98150ed: generated auth template.
  "ea76e368aded3bec47896e763182a91e02e991b5cdb1b2e96e4da6dbd4375aeb",
  // b1ce58019: generated auth template.
  "01da29006c659aac63ac25b164d0fae32f23b57da291126ac5a4b2c6ce95619a",
];

function contentHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Checks authored files before provisioning, then returns the local scaffold operation. */
export async function prepareWebAuthScaffold(input: {
  environmentRoot: string;
  agentAppRoot: string;
  webRoot?: string;
  force?: boolean;
}): Promise<() => Promise<void>> {
  const webRoot = input.webRoot ?? join(input.environmentRoot, "apps", "web");
  const channelPath = join(input.agentAppRoot, "agent", "channels", "eve.ts");
  const authPath = relative(dirname(channelPath), join(webRoot, "lib", "auth.js"))
    .split(sep)
    .join("/");
  const channel = WEB_CHANNEL_TEMPLATES["sign-in-with-vercel"].replace(
    '"@/lib/auth"',
    JSON.stringify(authPath.startsWith(".") ? authPath : `./${authPath}`),
  );
  const writes = [
    ...Object.entries(WEB_APP_SIGN_IN_WITH_VERCEL_TEMPLATE_FILES)
      .filter(([path]) => path !== "app/layout.tsx")
      .map(([path, source]) => ({
        path: join(webRoot, path),
        source: source.replaceAll("__EVE_INIT_APP_NAME__", () =>
          JSON.stringify(basename(input.agentAppRoot)).slice(1, -1),
        ),
        previousHashes: [
          ...[WEB_APP_TEMPLATE_FILES[path as keyof typeof WEB_APP_TEMPLATE_FILES]]
            .filter((source) => source !== undefined)
            .map(contentHash),
          ...(path === "lib/auth.ts" ? LEGACY_AUTH_HASHES : []),
        ],
      })),
    {
      path: channelPath,
      source: channel,
      previousHashes: [contentHash(WEB_CHANNEL_TEMPLATES.default)],
    },
  ];
  for (const file of writes) {
    const current = await readOptional(file.path);
    if (
      !input.force &&
      current !== undefined &&
      current !== file.source &&
      !file.previousHashes.includes(contentHash(current))
    ) {
      throw new Error(
        `Could not add Sign in with Vercel because ${file.path} contains authored code. Preserve your changes and integrate auth manually, or retry setup with --overwrite.`,
      );
    }
  }
  const packagePath = join(input.environmentRoot, "package.json");
  return async () => {
    const document = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    document.dependencies = {
      ...document.dependencies,
      "@vercel/oidc":
        document.dependencies?.["@vercel/oidc"] ??
        resolveVersionToken(
          "vercelOidcPackageVersion",
          resolveWebPackageVersions(undefined, "sign-in-with-vercel").vercelOidcPackageVersion,
        ),
      // The generated provider configuration requires this build's authentication API.
      "better-auth": resolveVersionToken(
        "betterAuthPackageVersion",
        resolveWebPackageVersions(undefined, "sign-in-with-vercel").betterAuthPackageVersion,
      ),
    };
    for (const file of writes) await writeTextFile(file.path, file.source, { force: true });
    await writeTextFile(packagePath, `${JSON.stringify(document, null, 2)}\n`, { force: true });
    await appendEnv(join(input.environmentRoot, ".env.example"), {
      VERCEL_APP_CLIENT_ID: "",
      VERCEL_APP_AUTH_METHOD: "oidc_token",
      BETTER_AUTH_SECRET: "",
    });
  };
}
