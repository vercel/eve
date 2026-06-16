const LOCAL_SITE_HOST = "localhost:3000";

/** Returns the configured public site origin, with a non-secret local fallback. */
export const getSiteOrigin = () => {
  const host = process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL ?? LOCAL_SITE_HOST;
  const protocol = host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https";

  return `${protocol}://${host}`;
};
