import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  experimental: {
    useTypeScriptCli: true,
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default withEve(nextConfig);
