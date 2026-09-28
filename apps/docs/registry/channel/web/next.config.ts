import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = { experimental: { useTypeScriptCli: true } };

export default withEve(nextConfig);
