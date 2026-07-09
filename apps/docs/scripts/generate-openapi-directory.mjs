import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyTrancoBoost, fetchTrancoRanks } from "./tranco.mjs";

const SOURCE_URL = "https://api.apis.guru/v2/list.json";
const OUTPUT_PATH = path.join(
  process.cwd(),
  "lib",
  "integrations",
  "generated-openapi-catalog.json",
);

const limit = Number.parseInt(process.env.EVE_GENERATED_OPENAPI_LIMIT ?? "", 10);

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

const [response, trancoRanks] = await Promise.all([fetch(SOURCE_URL), fetchTrancoRanks()]);
if (!response.ok) {
  throw new Error(`Failed to fetch ${SOURCE_URL}: ${response.status} ${response.statusText}`);
}

const directory = await response.json();
const records = Object.entries(directory)
  .flatMap(([id, api]) => {
    const version = api?.preferred;
    const versionRecord = version ? api?.versions?.[version] : undefined;
    const info = versionRecord?.info ?? {};
    const specUrl = versionRecord?.swaggerUrl ?? versionRecord?.swaggerYamlUrl;
    if (typeof specUrl !== "string" || !specUrl.startsWith("http")) return [];

    const title = cleanText(info.title) || id;
    const provider = cleanText(info["x-providerName"]) || id.split(":")[0] || title;
    const service = cleanText(info["x-serviceName"]);
    const description = cleanText(info.description);
    const displayName =
      service && !title.toLowerCase().includes(service.toLowerCase())
        ? `${title} ${service}`
        : title;
    const docsHref = versionRecord.externalDocs?.url ?? versionRecord.link ?? specUrl;
    const slugBase = slugify(`${provider}-${service || title}`) || slugify(id) || "api";

    return [
      {
        slug: `openapi-directory-${slugBase}-${hash(id)}`,
        name: truncate(displayName, 72),
        provider: truncate(provider, 64),
        tagline: truncate(description || `OpenAPI tools for ${displayName}.`, 180),
        specUrl,
        docsHref,
        originId: id,
        version,
        popularity: 0,
        source: "APIs.guru OpenAPI Directory",
        sourceUrl: SOURCE_URL,
        keywords: [provider, service, title, id, version, "openapi", "generated"].filter(Boolean),
      },
    ];
  })
  .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

// Group API-only provider domains with their brand domain so one flagship
// spec per brand gets the boost. Bulk specs are unvetted; halve their boost
// like registry-only MCP entries.
const providerGroup = (provider) =>
  provider.toLowerCase() === "googleapis.com" ? "google.com" : provider.toLowerCase();
applyTrancoBoost(
  records,
  trancoRanks,
  (record) => providerGroup(record.provider),
  () => 0.5,
);

const limitedRecords = Number.isFinite(limit) && limit > 0 ? records.slice(0, limit) : records;

await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await writeFile(`${OUTPUT_PATH}.tmp`, `${JSON.stringify(limitedRecords)}\n`);
await rename(`${OUTPUT_PATH}.tmp`, OUTPUT_PATH);

console.log(
  `Wrote ${limitedRecords.length.toLocaleString()} generated OpenAPI records to ${OUTPUT_PATH}`,
);
