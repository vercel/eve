import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {};

export default withEve(nextConfig, {
  agents: {
    support: "./agents/support",
    billing: {
      root: "./agents/billing",
      buildCommand: "pnpm --dir ../.. build:billing-agent",
      servicePrefix: "/_eve_internal/billing",
    },
    research: "./agents/research",
  },
});
