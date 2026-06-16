import {
  geistShikiTheme,
  geistdocsFrontmatterSchema,
  geistdocsMetaSchema,
} from "@vercel/geistdocs/source-config";
import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import lastModified, { type LastModifiedPluginOptions } from "fumadocs-mdx/plugins/last-modified";

// Some docs use non-standard fenced code labels like
// `\`\`\`384:401:path/to/file.ts` (line range + file path instead of a
// language). Shiki rejects those. Normalize anything that isn't a plain
// language identifier to `text`, preserving the original label as fence
// meta so it still renders above the block.
const remarkNormalizeCodeLang = () => (tree: { children?: unknown[] }) => {
  const validLang = /^[a-zA-Z][a-zA-Z0-9+#-]*$/;
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: string; lang?: string; meta?: string; children?: unknown[] };
    if (n.type === "code" && typeof n.lang === "string" && !validLang.test(n.lang)) {
      n.meta = n.meta ? `${n.lang} ${n.meta}` : n.lang;
      n.lang = "text";
    }
    if (Array.isArray(n.children)) for (const c of n.children) walk(c);
  };
  walk(tree);
};

// Shared frontmatter schema for `docs/`: title required, description
// optional, no body H1 (Fumadocs renders the title from frontmatter). The
// schema is provided by the Geistdocs package so the docs site stays in sync
// with the fields the package's routes and components expect.
const sharedDocsSchema = geistdocsFrontmatterSchema;

export const docs = defineDocs({
  dir: "../../docs",
  docs: {
    // The top-level README.md in each rendered directory is engineer-facing
    // and excluded from the site. A directory that should render as a clickable
    // sidebar folder uses an `index.md` (e.g. channels/index.md), which
    // Fumadocs auto-detects as the folder index.
    files: ["**/*.{md,mdx}", "!README.md"],
    schema: sharedDocsSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: geistdocsMetaSchema,
  },
});

const lastModifiedVersionControl: LastModifiedPluginOptions["versionControl"] =
  process.env.VERCEL === "1" ? async () => null : "git";

// Keep the Geistdocs source defaults inline so Vercel builds can avoid the
// git-backed last-modified lookup when the deployment checkout is shallow.
export default defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMdxMermaid, remarkNormalizeCodeLang],
    rehypeCodeOptions: {
      themes: {
        light: geistShikiTheme,
        dark: geistShikiTheme,
      },
      defaultColor: "light",
    },
  },
  plugins: [lastModified({ versionControl: lastModifiedVersionControl })],
});
