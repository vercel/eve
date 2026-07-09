/**
 * Favicon proxy for generated integration entries. Serves the provider
 * domain's favicon so thousands of generated entries get real logos without
 * storing any assets. Tries Google's favicon service first, then DuckDuckGo's,
 * then a neutral globe. Both upstreams signal "no favicon" detectably: Google
 * resolves to a 404 (after its redirect) and DuckDuckGo returns an empty body.
 */

const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9.-]{0,251}\.[a-z]{2,}$/;

const CACHE_CONTROL = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800";

const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#8f8f8f" stroke-width="1.5"/><path d="M3 12h18M12 3a13.5 13.5 0 0 1 0 18M12 3a13.5 13.5 0 0 0 0 18" stroke="#8f8f8f" stroke-width="1.5"/></svg>`;

const imageResponse = (body: ArrayBuffer, contentType: string) =>
  new Response(body, {
    headers: { "content-type": contentType, "cache-control": CACHE_CONTROL },
  });

const fallbackResponse = () =>
  new Response(FALLBACK_SVG, {
    headers: { "content-type": "image/svg+xml", "cache-control": CACHE_CONTROL },
  });

const tryFetchIcon = async (
  url: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> => {
  try {
    const upstream = await fetch(url, { next: { revalidate: 86400 } });
    if (!upstream.ok) return null;
    const body = await upstream.arrayBuffer();
    if (body.byteLength === 0) return null;
    return { body, contentType: upstream.headers.get("content-type") ?? "image/png" };
  } catch {
    return null;
  }
};

export async function GET(_request: Request, { params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;
  const normalized = decodeURIComponent(domain).toLowerCase();
  if (!DOMAIN_PATTERN.test(normalized)) {
    return fallbackResponse();
  }
  const encoded = encodeURIComponent(normalized);
  const google = await tryFetchIcon(`https://www.google.com/s2/favicons?domain=${encoded}&sz=64`);
  if (google) {
    return imageResponse(google.body, google.contentType);
  }
  const duckduckgo = await tryFetchIcon(`https://icons.duckduckgo.com/ip3/${encoded}.ico`);
  if (duckduckgo) {
    return imageResponse(duckduckgo.body, duckduckgo.contentType);
  }
  return fallbackResponse();
}
