import type { WebChatFramework } from "./framework.js";

/** `apps/web/next.config.ts` written when the Next.js app hosts the agent itself. */
export const NEXT_HOSTED_CONFIG = `import type { NextConfig } from "next";
import { withEve } from "eve/next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {};
const eveRoot = fileURLToPath(new URL("../..", import.meta.url));

export default withEve(nextConfig, { eveRoot });
`;

/** `apps/web/vite.config.ts` written when the TanStack Start app hosts the agent itself. */
export const TANSTACK_HOSTED_VITE_CONFIG = `import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { eveTanStack } from "eve/tanstack";
import { nitro } from "nitro/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const eveRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    eveTanStack({ eveRoot }),
    tailwindcss(),
    tanstackStart({ srcDirectory: "app" }),
    viteReact(),
    nitro(),
  ],
});
`;

/** The config the installer writes when the web app hosts the agent itself. */
export const FRAMEWORK_HOSTED_CONFIGS: Record<WebChatFramework, { file: string; source: string }> =
  {
    next: { file: "next.config.ts", source: NEXT_HOSTED_CONFIG },
    tanstack: { file: "vite.config.ts", source: TANSTACK_HOSTED_VITE_CONFIG },
  };
