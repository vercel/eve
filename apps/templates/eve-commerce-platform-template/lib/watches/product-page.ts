import { lookup } from "node:dns";
import { get } from "node:https";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { isPublicAddress, productUrl } from "./product-url.ts";

const maxPageBytes = 1024 * 1024;
const timeoutMs = 12_000;

export interface ProductOffer {
  readonly inStock: boolean;
  readonly usdCents: number | null;
}

export async function readProductOffer(url: string): Promise<ProductOffer | undefined> {
  let page = productUrl(url);
  const options = offerOptions(page);
  const signal = AbortSignal.timeout(timeoutMs);
  for (let redirects = 0; redirects <= 2; redirects++) {
    const response = await getPage(page, signal);
    if ("html" in response) return parseProductOffer(response.html, page);
    const next = productUrl(new URL(response.redirect, page).href);
    if (next.origin !== page.origin || !hasSameOptions(next, options)) return undefined;
    page = next;
  }
  return undefined;
}

function getPage(url: URL, signal: AbortSignal): Promise<{ html: string } | { redirect: string }> {
  return new Promise((resolve, reject) => {
    const request = get(
      url,
      {
        agent: false,
        family: 4,
        signal,
        headers: { Accept: "text/html", "User-Agent": "evey-product-watch/1.0" },
        lookup(host, _options, callback) {
          lookup(host, { family: 4, all: true }, (error, addresses) => {
            if (error) return callback(error, "", 4);
            const [first] = addresses;
            if (!first || addresses.some(({ address }) => !isPublicAddress(address))) {
              return callback(
                new Error("Product URL did not resolve to public IPv4 addresses."),
                "",
                4,
              );
            }
            callback(null, first.address, 4);
          });
        },
      },
      async (response) => {
        try {
          const status = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
            response.destroy();
            resolve({ redirect: response.headers.location });
            return;
          }
          if (
            status !== 200 ||
            !/^text\/html\b/i.test(response.headers["content-type"] ?? "") ||
            Number(response.headers["content-length"]) > maxPageBytes
          ) {
            response.destroy();
            throw new Error("Product page did not return a readable HTML document.");
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of response) {
            bytes += chunk.length;
            if (bytes > maxPageBytes) {
              response.destroy();
              throw new Error("Product page exceeded the read limit.");
            }
            chunks.push(chunk);
          }
          resolve({ html: Buffer.concat(chunks).toString("utf8") });
        } catch (error) {
          reject(error);
        }
      },
    );
    request.on("error", reject);
  });
}

export function parseProductOffer(html: string, page: URL): ProductOffer | undefined {
  const nodes: DefaultTreeAdapterMap["node"][] = [parse(html)];
  const products: Record<string, unknown>[] = [];
  while (nodes.length > 0) {
    const node = nodes.pop();
    if (!node) break;
    if ("childNodes" in node) for (const child of node.childNodes) nodes.push(child);
    if (
      !("tagName" in node) ||
      node.tagName !== "script" ||
      node.attrs.find((attr) => attr.name === "type")?.value.toLowerCase() !== "application/ld+json"
    )
      continue;
    const text = node.childNodes.find((child) => "value" in child);
    if (!text || !("value" in text)) continue;
    try {
      collectProducts(JSON.parse(text.value), products);
    } catch {
      continue;
    }
  }

  const [product] = products;
  if (
    products.length !== 1 ||
    !product ||
    !schemaType(product, "Product") ||
    schemaType(product, "ProductGroup") ||
    Boolean(product.hasVariant)
  )
    return undefined;
  const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
  const offer = record(offers[0]);
  if (
    offers.length !== 1 ||
    !offer ||
    !schemaType(offer, "Offer") ||
    !matchesPage(offer, product, page)
  )
    return undefined;
  const availability =
    typeof offer.availability === "string" ? offer.availability.split("/").at(-1) : undefined;
  if (
    !availability ||
    ![
      "InStock",
      "OutOfStock",
      "SoldOut",
      "Discontinued",
      "PreOrder",
      "PreSale",
      "BackOrder",
      "LimitedAvailability",
      "OnlineOnly",
      "InStoreOnly",
    ].includes(availability)
  )
    return undefined;

  return {
    inStock:
      availability === "InStock" ||
      availability === "LimitedAvailability" ||
      availability === "OnlineOnly",
    usdCents: offer.priceCurrency === "USD" ? usdCents(offer.price) : null,
  };
}

function offerOptions(url: URL) {
  return [...url.searchParams].filter(([key]) => !/^(?:utm_.+|gclid|fbclid|ref)$/i.test(key));
}

function hasSameOptions(url: URL, expected: [string, string][]) {
  return JSON.stringify(offerOptions(url).sort()) === JSON.stringify([...expected].sort());
}

function matchesPage(offer: Record<string, unknown>, product: Record<string, unknown>, page: URL) {
  const options = offerOptions(page);
  if (options.length && typeof offer.url !== "string") return false;
  const declared = offer.url ?? product.url;
  if (declared === undefined) return true;
  const target = typeof declared === "string" ? URL.parse(declared, page) : null;
  return (
    target !== null &&
    target.origin === page.origin &&
    target.pathname.replace(/\/$/, "") === page.pathname.replace(/\/$/, "") &&
    hasSameOptions(target, options)
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function schemaType(value: Record<string, unknown>, match: string) {
  const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  return types.some(
    (type) =>
      type === match ||
      type === `https://schema.org/${match}` ||
      type === `http://schema.org/${match}`,
  );
}

function collectProducts(value: unknown, products: Record<string, unknown>[]) {
  const queue = [value];
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (Array.isArray(item)) {
      for (const child of item) queue.push(child);
      continue;
    }
    const entry = record(item);
    if (!entry) continue;
    if (schemaType(entry, "Product") || schemaType(entry, "ProductGroup")) products.push(entry);
    if (entry["@graph"]) queue.push(entry["@graph"]);
  }
}

function usdCents(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match?.[1]) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}
