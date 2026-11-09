import { join } from "node:path";

import { select } from "#setup/ask.js";
import { pathExists } from "#setup/scaffold/files.js";

/** Frontend frameworks the Web Chat installer can generate. */
export type WebChatFramework = "next" | "tanstack";

export const WEB_CHAT_FRAMEWORK_LABELS: Readonly<Record<WebChatFramework, string>> = {
  next: "Next.js",
  tanstack: "TanStack Start",
};

/** Asked by `eve add channel/web` before it installs the frontend files. */
export const WEB_FRAMEWORK_QUESTION = select<WebChatFramework>({
  key: "web-framework",
  message: "Which framework should Web Chat use?",
  options: [
    {
      id: "next",
      label: WEB_CHAT_FRAMEWORK_LABELS.next,
      hint: "(Recommended) Supports Sign in with Vercel.",
      value: "next",
    },
    {
      id: "tanstack",
      label: WEB_CHAT_FRAMEWORK_LABELS.tanstack,
      hint: "A Vite app built with TanStack Router.",
      value: "tanstack",
    },
  ],
  recommended: "next",
  required: true,
});

const HOST_CONFIG_FILES: Readonly<Record<WebChatFramework, readonly string[]>> = {
  next: ["next.config.ts", "next.config.mjs", "next.config.js"],
  tanstack: ["vite.config.ts", "vite.config.mjs", "vite.config.js"],
};

async function hasAny(
  root: string,
  files: readonly string[],
  exists: typeof pathExists,
): Promise<boolean> {
  for (const file of files) {
    if (await exists(join(root, file))) return true;
  }
  return false;
}

/** The framework of the app already in `webRoot`, or `undefined` when it has none. */
export async function detectWebChatFramework(
  webRoot: string,
  exists: typeof pathExists = pathExists,
): Promise<WebChatFramework | undefined> {
  const [next, tanstack] = await Promise.all([
    hasAny(webRoot, HOST_CONFIG_FILES.next, exists),
    hasAny(webRoot, HOST_CONFIG_FILES.tanstack, exists),
  ]);
  if (next && tanstack) {
    throw new Error(
      `${webRoot} contains both a Next.js and a Vite config. Remove the app you no longer use, then retry.`,
    );
  }
  return next ? "next" : tanstack ? "tanstack" : undefined;
}
