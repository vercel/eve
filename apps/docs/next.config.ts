import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const withMDX = createMDX();

const localSiteHost = "localhost:3000";

const config: NextConfig = {
  env: {
    NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL:
      process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL ?? localSiteHost,
  },

  // The integrations gallery sources identity from the workspace package
  // `@vercel/eve-catalog`; transpile it from source so dev and build compile
  // its TypeScript without a separate prebuild step.
  transpilePackages: ["@vercel/eve-catalog"],

  experimental: {
    turbopackFileSystemCacheForDev: true,
  },

  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "placehold.co",
      },
    ],
  },

  async redirects() {
    return [
      {
        source: "/docs",
        destination: "/docs/introduction",
        permanent: true,
      },
      {
        source: "/:lang/docs",
        destination: "/:lang/docs/introduction",
        permanent: true,
      },
      // Evals moved from a single Advanced page to a top-level section.
      {
        source: "/docs/advanced/evals",
        destination: "/docs/evals/overview",
        permanent: true,
      },
      {
        source: "/:lang/docs/advanced/evals",
        destination: "/:lang/docs/evals/overview",
        permanent: true,
      },
    ];
  },
};

export default withMDX(config);
