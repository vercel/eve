const LOCAL_SITE_HOST = "localhost:3000";

/** Returns the configured public site origin, with a non-secret local fallback. */
export const getSiteOrigin = () => {
  const site = process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL ?? LOCAL_SITE_HOST;

  if (site.includes("://")) {
    const url = new URL(site);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Unsupported site URL protocol: ${url.protocol}`);
    }
    return url.origin;
  }

  const protocol = site.startsWith("localhost") || site.startsWith("127.0.0.1") ? "http" : "https";
  return `${protocol}://${site}`;
};
