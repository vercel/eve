import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The template's root AGENTS.md already points agents at the eve docs.
  agentRules: false,
};

export default nextConfig;
