import type { NextConfig } from "next";
import { resolve } from "node:path";

export default {
  agentRules: false,
  devIndicators: false,
  turbopack: { root: resolve(import.meta.dirname, "../../..") },
} satisfies NextConfig;
