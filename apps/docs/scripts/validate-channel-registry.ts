import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { channelEntries } from "@vercel/eve-catalog";

interface RegistryFile {
  path: string;
  target?: string;
}

interface RegistryItem {
  name: string;
  dependencies?: string[];
  files?: RegistryFile[];
  meta?: {
    eve?: {
      setup?: {
        command?: string;
        package?: string;
        bin?: string;
        args?: string[];
      };
    };
  };
}

interface Registry {
  items: RegistryItem[];
}

const registrySlugsByCatalogSlug: Readonly<Record<string, string>> = {
  eve: "web",
  photon: "photon-imessage",
};

const setupKindsByCatalogSlug: Readonly<Record<string, string>> = {
  eve: "web",
  photon: "photon",
};

const adapterDependenciesByCatalogSlug: Readonly<Record<string, string>> = {
  "chat-sdk-gchat": "@chat-adapter/gchat",
  "chat-sdk-whatsapp": "@chat-adapter/whatsapp",
  "chat-sdk-x": "@chat-adapter/x",
  "chat-sdk-messenger": "@chat-adapter/messenger",
  "chat-sdk-zernio": "@zernio/chat-sdk-adapter",
  "chat-sdk-velt": "@veltdev/chat-sdk-adapter",
  "chat-sdk-sendblue": "chat-adapter-sendblue",
  "chat-sdk-novu": "@novu/chat-sdk-adapter",
  "chat-sdk-liveblocks": "@liveblocks/chat-sdk-adapter",
  "chat-sdk-linq": "@linqapp/chat-sdk-adapter",
  "chat-sdk-kapso": "@kapso/chat-adapter",
  "chat-sdk-dial": "@getdial/chat-sdk-adapter",
  "chat-sdk-agentphone": "@agentphone/chat-sdk-adapter",
  "chat-sdk-lark": "@larksuite/vercel-chat-adapter",
  "chat-sdk-beeper": "@beeper/chat-adapter-matrix",
  "chat-sdk-resend": "@resend/chat-sdk-adapter",
};

const targetSlugsByCatalogSlug: Readonly<Record<string, string>> = {
  "linear-agent": "linear",
  "chat-sdk-gchat": "gchat",
  "chat-sdk-whatsapp": "whatsapp",
  "chat-sdk-x": "x",
  "chat-sdk-messenger": "messenger",
  "chat-sdk-zernio": "zernio",
  "chat-sdk-velt": "velt",
  "chat-sdk-sendblue": "sendblue",
  "chat-sdk-novu": "novu",
  "chat-sdk-liveblocks": "liveblocks",
  "chat-sdk-linq": "linq",
  "chat-sdk-kapso": "kapso",
  "chat-sdk-dial": "dial",
  "chat-sdk-agentphone": "agentphone",
  "chat-sdk-lark": "lark",
  "chat-sdk-beeper": "beeper",
  "chat-sdk-resend": "resend",
};

const docsRoot = join(import.meta.dirname, "..");
const registry = JSON.parse(await readFile(join(docsRoot, "registry.json"), "utf8")) as Registry;
const items = registry.items.filter((item) => item.name.startsWith("channel/"));
const galleryEntries = channelEntries().filter((entry) => entry.surfaces.gallery);
const expectedSlugs = galleryEntries.map(
  (entry) => registrySlugsByCatalogSlug[entry.slug] ?? entry.slug,
);
const actualSlugs = items.map((item) => item.name.slice("channel/".length));

if (JSON.stringify(actualSlugs) !== JSON.stringify(expectedSlugs)) {
  throw new Error(
    `Channel registry entries do not match the gallery.\nExpected: ${expectedSlugs.join(", ")}\nActual: ${actualSlugs.join(", ")}`,
  );
}

for (const [index, item] of items.entries()) {
  const setup = item.meta?.eve?.setup;
  if (
    setup !== undefined &&
    (setup.command === undefined ||
      setup.package === undefined ||
      setup.bin === undefined ||
      setup.args === undefined)
  ) {
    throw new Error(
      `Registry item "${item.name}" setup must declare command, package, bin, and args during the migration.`,
    );
  }

  const entry = galleryEntries[index];
  if (entry === undefined) throw new Error(`Unexpected channel registry item "${item.name}".`);
  const registrySlug = expectedSlugs[index];

  if (entry.slug === "slack" || entry.slug === "eve" || entry.slug === "photon") {
    const expectedArgs = [
      "integration",
      "setup",
      setupKindsByCatalogSlug[entry.slug] ?? registrySlug,
    ];
    if (
      setup?.command !== "eve" ||
      setup.package !== "eve" ||
      setup.bin !== "eve" ||
      JSON.stringify(setup.args) !== JSON.stringify(expectedArgs)
    ) {
      throw new Error(
        `Registry item "${item.name}" must delegate setup to eve integration setup ${expectedArgs[2]}.`,
      );
    }
    continue;
  }

  const expectedPath = `registry/channels/${entry.slug}.ts`;
  const expectedTarget = `agent/channels/${targetSlugsByCatalogSlug[entry.slug] ?? entry.slug}.ts`;
  const file = item.files?.[0];
  if (item.files?.length !== 1 || file?.path !== expectedPath || file.target !== expectedTarget) {
    throw new Error(
      `Registry item "${item.name}" must write ${expectedPath} to ${expectedTarget}.`,
    );
  }
  await access(join(docsRoot, expectedPath));

  const adapterDependency = adapterDependenciesByCatalogSlug[entry.slug];
  if (entry.slug.startsWith("chat-sdk-") && adapterDependency === undefined) {
    throw new Error(`Registry item "${item.name}" has no adapter dependency mapping.`);
  }
  if (adapterDependency !== undefined) {
    const dependencies = item.dependencies ?? [];
    if (
      !dependencies.includes("chat") ||
      !dependencies.includes(adapterDependency) ||
      !dependencies.includes("@chat-adapter/state-memory")
    ) {
      throw new Error(
        `Registry item "${item.name}" must install Chat SDK, ${adapterDependency}, and its state adapter.`,
      );
    }
  }
}
