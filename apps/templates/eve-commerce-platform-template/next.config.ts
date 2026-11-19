import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  agentRules: false,
  devIndicators: { position: "bottom-right" },
};

export default withEve(nextConfig);
