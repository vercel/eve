import { createRequire } from "node:module";
import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";
import {
  compatibilityRedirects,
  docsRedirects,
  rootMarkdownRedirects,
} from "./lib/geistdocs/redirects";

const withMDX = createMDX();
const require = createRequire(import.meta.url);
const wgslLoader = require.resolve("@vgpu/wgsl/loader-webpack");

const localSiteHost = "localhost:3000";

const config: NextConfig = {
  env: {
    NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL:
      process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL ?? localSiteHost,
  },

  // The integrations gallery sources identity from the workspace package
  // `@eve/catalog`; transpile it from source so dev and build compile
  // its TypeScript without a separate prebuild step.
  transpilePackages: ["@eve/catalog"],

  experimental: {
    globalNotFound: true,
    turbopackFileSystemCacheForDev: true,
  },

  turbopack: {
    rules: {
      "*.wgsl": {
        loaders: [wgslLoader],
        as: "*.js",
      },
    },
  },

  images: {
    formats: ["image/avif", "image/webp"],
    qualities: [75, 95],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "placehold.co",
      },
    ],
  },

  async rewrites() {
    return [
      {
        source: "/sitemap.xml",
        destination: "https://crawled-sitemap.vercel.sh/eve.dev-.xml",
      },
    ];
  },

  async redirects() {
    return [
      {
        source: "/docs",
        destination: "/docs/getting-started",
        permanent: true,
      },
      {
        source: "/:lang/docs",
        destination: "/:lang/docs/getting-started",
        permanent: true,
      },
      ...compatibilityRedirects,
      ...docsRedirects,
      ...rootMarkdownRedirects,
    ];
  },
};

export default withMDX(config);
