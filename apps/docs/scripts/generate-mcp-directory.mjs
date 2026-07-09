import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyTrancoBoost, fetchTrancoRanks } from "./tranco.mjs";

/**
 * Generates the bulk MCP connection catalog from public registries:
 *
 * - the official MCP registry (registry.modelcontextprotocol.io), filtered to
 *   the latest active version of servers that publish a remote endpoint, and
 * - the Anthropic MCP directory (api.anthropic.com/api/directory/servers),
 *   filtered to remote servers.
 *
 * Records from both feeds are merged by canonicalized endpoint URL (host +
 * path, `www.` and trailing slashes stripped); the directory feed wins
 * descriptive fields because its copy is curated, and the registry fills in
 * anything missing. Only remote (streamable-http / SSE) servers are kept —
 * stdio-only packages cannot be used by an eve agent as a connection.
 */

const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0/servers";
const DIRECTORY_URL = "https://api.anthropic.com/api/directory/servers";
const OUTPUT_PATH = path.join(process.cwd(), "lib", "integrations", "generated-mcp-catalog.json");

const limit = Number.parseInt(process.env.EVE_GENERATED_MCP_LIMIT ?? "", 10);

/**
 * Ephemeral tunnels and dev hosts (dead on arrival), plus Anthropic-gated
 * proxies (mcp.claude.com endpoints only accept Claude clients).
 */
const JUNK_DOMAIN_SUFFIXES = [
  ".claude.com",
  ".claude.ai",
  ".anthropic.com",
  ".trycloudflare.com",
  ".ngrok.io",
  ".ngrok.app",
  ".ngrok-free.app",
  ".ngrok.dev",
  ".loca.lt",
  ".serveo.net",
  ".localhost.run",
];

/**
 * Registry spam guard: gateways and aggregators publish hundreds of per-tool
 * entries under one domain. Anthropic-directory records are curated and exempt.
 */
const MAX_RECORDS_PER_DOMAIN = 10;

/**
 * Hosting platforms where the registrable domain belongs to the platform, not
 * the service — using it for favicons would brand every entry with the
 * platform's logo. Keep the full host for these.
 */
const PLATFORM_SUFFIXES = [
  ".vercel.app",
  ".workers.dev",
  ".pages.dev",
  ".onrender.com",
  ".herokuapp.com",
  ".netlify.app",
  ".railway.app",
  ".up.railway.app",
  ".fly.dev",
  ".azurewebsites.net",
  ".amazonaws.com",
  ".cloudfront.net",
  ".github.io",
  ".alpic.live",
  ".fastmcp.app",
];

/** API-only domains that serve no favicon; remap to the brand domain. */
const LOGO_DOMAIN_REMAP = new Map([
  ["googleapis.com", "google.com"],
  ["adobe.io", "adobe.com"],
  ["atlassian.net", "atlassian.com"],
  ["todoist.net", "todoist.com"],
]);

/** Country-code second-level suffixes where eTLD+1 needs three labels. */
const SECOND_LEVEL_TLDS = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "or.jp",
  "ne.jp",
  "co.in",
  "co.nz",
  "co.kr",
  "co.za",
  "com.br",
  "com.mx",
  "com.tr",
  "com.cn",
  "com.sg",
  "com.hk",
  "com.tw",
]);

/**
 * Approximate registrable domain (eTLD+1), used for favicon lookups and the
 * provider label — subdomains like `mcp.canva.com` rarely serve a favicon,
 * while `canva.com` does. Not a full Public Suffix List; a wrong guess only
 * costs a fallback icon.
 */
const rootDomain = (host) => {
  if (PLATFORM_SUFFIXES.some((suffix) => host.endsWith(suffix))) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return LOGO_DOMAIN_REMAP.get(host) ?? host;
  const labels = SECOND_LEVEL_TLDS.has(parts.slice(-2).join(".")) ? 3 : 2;
  const root = parts.slice(-labels).join(".");
  return LOGO_DOMAIN_REMAP.get(root) ?? root;
};

const cleanText = (value) =>
  String(value ?? "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#*_`>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const truncate = (value, maxLength) => {
  if (value.length <= maxLength) return value;
  const clipped = value.slice(0, maxLength - 1);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, lastSpace > 80 ? lastSpace : clipped.length).trim()}...`;
};

const slugify = (value) =>
  cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);

const hash = (value) => createHash("sha1").update(value).digest("hex").slice(0, 8);

const parseEndpoint = (value) => {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!hostname.includes(".") || hostname === "localhost" || hostname.endsWith(".local")) {
    return null;
  }
  if (JUNK_DOMAIN_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return null;
  const pathname = url.pathname.replace(/\/+$/, "");
  return { canonical: `${hostname}${pathname}`, domain: hostname, url: value };
};

const fetchJson = async (url) => {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
};

/** Latest active registry versions that expose a remote endpoint. */
const fetchRegistryServers = async () => {
  const records = [];
  let cursor;
  do {
    const pageUrl = new URL(REGISTRY_URL);
    pageUrl.searchParams.set("limit", "100");
    if (cursor) pageUrl.searchParams.set("cursor", cursor);
    const page = await fetchJson(pageUrl.toString());
    for (const entry of page.servers ?? []) {
      const server = entry.server ?? entry;
      const official = entry._meta?.["io.modelcontextprotocol.registry/official"];
      if (official && (official.isLatest !== true || official.status !== "active")) continue;
      const remote = (server.remotes ?? []).find(
        (candidate) =>
          (candidate.type === "streamable-http" || candidate.type === "sse") &&
          parseEndpoint(candidate.url) !== null,
      );
      if (!remote) continue;
      const endpoint = parseEndpoint(remote.url);
      const authHeaders = (remote.headers ?? [])
        .filter((header) => header.isRequired === true && typeof header.name === "string")
        .slice(0, 3)
        .map((header) => ({
          name: header.name,
          description: truncate(cleanText(header.description), 140) || undefined,
          secret: header.isSecret === true,
        }));
      records.push({
        endpoint,
        name: cleanText(server.title) || cleanText(server.name) || endpoint.domain,
        tagline: cleanText(server.description),
        transport: remote.type === "sse" ? "sse" : "http",
        docsHref: server.websiteUrl ?? server.repository?.url,
        categories: [],
        authHint: authHeaders.length > 0 ? "headers" : "unknown",
        authHeaders,
        popularity: 0,
        feed: "mcp-registry",
        registryName: server.name,
      });
    }
    cursor = page.metadata?.nextCursor;
  } while (cursor);
  return records;
};

/** Remote servers from the Anthropic MCP directory. */
const fetchDirectoryServers = async () => {
  const records = [];
  let cursor;
  do {
    const pageUrl = new URL(DIRECTORY_URL);
    if (cursor) pageUrl.searchParams.set("cursor", cursor);
    const page = await fetchJson(pageUrl.toString());
    for (const server of page.servers ?? []) {
      if (server.type !== "remote") continue;
      const endpoint = parseEndpoint(server.remote?.url);
      if (!endpoint) continue;
      records.push({
        endpoint,
        name: cleanText(server.display_name) || cleanText(server.name) || endpoint.domain,
        tagline: cleanText(server.one_liner) || cleanText(server.description),
        transport: server.remote?.transport === "sse" ? "sse" : "http",
        docsHref: server.documentation ?? server.author?.url,
        categories: (server.categories ?? []).map(cleanText).filter(Boolean),
        // Directory connectors authenticate via OAuth unless marked authless.
        authHint: server.remote?.is_authless === true ? "none" : "oauth",
        authHeaders: [],
        popularity:
          typeof server.popularity_score === "number" && server.popularity_score > 0
            ? Math.round(server.popularity_score)
            : 0,
        feed: "anthropic-directory",
      });
    }
    cursor = page.next_cursor;
  } while (cursor);
  return records;
};

const [registryServers, directoryServers, trancoRanks] = await Promise.all([
  fetchRegistryServers(),
  fetchDirectoryServers(),
  fetchTrancoRanks(),
]);

// Merge by canonical endpoint. The directory feed is listed first so its
// curated copy wins; registry-only fields fill the gaps.
const merged = new Map();
for (const record of [...directoryServers, ...registryServers]) {
  const existing = merged.get(record.endpoint.canonical);
  if (existing === undefined) {
    merged.set(record.endpoint.canonical, { ...record, feeds: [record.feed] });
    continue;
  }
  if (!existing.feeds.includes(record.feed)) existing.feeds.push(record.feed);
  existing.tagline ||= record.tagline;
  existing.docsHref ||= record.docsHref;
  if (existing.categories.length === 0) existing.categories = record.categories;
  if (existing.authHint === "unknown") existing.authHint = record.authHint;
  if (existing.authHeaders.length === 0) existing.authHeaders = record.authHeaders;
  existing.popularity = Math.max(existing.popularity, record.popularity);
}

// Hosted-platform subdomains in the open registry are overwhelmingly demo and
// spam servers; keep them only when the vetted Anthropic directory lists them.
const trusted = [...merged.values()].filter(
  (record) =>
    record.feeds.includes("anthropic-directory") ||
    !PLATFORM_SUFFIXES.some((suffix) => record.endpoint.domain.endsWith(suffix)),
);

const perDomainCount = new Map();
const capped = trusted
  .sort((a, b) => {
    const aCurated = a.feeds.includes("anthropic-directory") ? 0 : 1;
    const bCurated = b.feeds.includes("anthropic-directory") ? 0 : 1;
    if (aCurated !== bCurated) return aCurated - bCurated;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  })
  .filter((record) => {
    if (record.feeds.includes("anthropic-directory")) return true;
    const root = rootDomain(record.endpoint.domain);
    const count = perDomainCount.get(root) ?? 0;
    perDomainCount.set(root, count + 1);
    return count < MAX_RECORDS_PER_DOMAIN;
  });

const records = capped
  .map((record) => {
    const { endpoint } = record;
    const name = truncate(record.name, 72);
    const root = rootDomain(endpoint.domain);
    return {
      slug: `mcp-directory-${slugify(name) || slugify(endpoint.domain) || "server"}-${hash(endpoint.canonical)}`,
      name,
      provider: root,
      domain: endpoint.domain,
      rootDomain: root,
      tagline: truncate(record.tagline || `Remote MCP server for ${name}.`, 180),
      url: endpoint.url,
      transport: record.transport,
      authHint: record.authHint,
      authBasis: "declared",
      authHeaders: record.authHeaders,
      popularity: record.popularity,
      docsHref: record.docsHref ?? `https://${endpoint.domain}`,
      categories: record.categories,
      feeds: record.feeds,
      source:
        record.feeds[0] === "anthropic-directory"
          ? "Anthropic MCP directory"
          : "official MCP registry",
      sourceUrl: record.feeds[0] === "anthropic-directory" ? DIRECTORY_URL : REGISTRY_URL,
      keywords: [
        endpoint.domain,
        ...record.categories,
        record.registryName,
        "mcp",
        "remote",
        "generated",
      ].filter((value) => typeof value === "string" && value.length > 0),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

// Anthropic-directory entries are vetted; bare registry entries are not
// (anyone can publish near a famous domain), so their domain boost is halved.
applyTrancoBoost(
  records,
  trancoRanks,
  (record) => record.rootDomain,
  (record) => (record.feeds.includes("anthropic-directory") ? 1 : 0.5),
);

const limitedRecords = Number.isFinite(limit) && limit > 0 ? records.slice(0, limit) : records;

await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await writeFile(`${OUTPUT_PATH}.tmp`, `${JSON.stringify(limitedRecords)}\n`);
await rename(`${OUTPUT_PATH}.tmp`, OUTPUT_PATH);

console.log(
  `Wrote ${limitedRecords.length.toLocaleString()} generated MCP records to ${OUTPUT_PATH} ` +
    `(registry: ${registryServers.length.toLocaleString()}, directory: ${directoryServers.length.toLocaleString()}, merged: ${merged.size.toLocaleString()})`,
);
