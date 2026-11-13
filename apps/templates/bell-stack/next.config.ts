import { withEve } from "eve/next";
import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  serverExternalPackages: ["@browserbasehq/sdk", "@browserbasehq/stagehand", "playwright-core", "pg"],
  turbopack: { root: process.cwd() },
};
export default withEve(config, { eveBuildCommand: "pnpm build:agent" });
