import type { NextConfig } from "next";

// eve is composed as a peer service in the root vercel.ts, so this stays a plain config.
// Cache Components + Partial Prefetching give instant navigations: pages render their static
// shell (header, layout) immediately and stream FastAPI data into <Suspense> fallbacks.
const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
