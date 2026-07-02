import { SiGithub } from "@icons-pack/react-simple-icons";
import { github } from "@/geistdocs";

// geistdocs' built-in EditSourceAction hardcodes a `/edit/` GitHub URL and a
// `content/docs/` path prefix, and exports neither the URL builder nor its
// styling. We disable it (`pageActions.editSource: false`) and render this
// `/blob/` link to the real source file instead. The class list mirrors the
// internal action style (layout/focus) so this entry matches its siblings.
const actionClassName =
  "group flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md text-left text-sm leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-600 focus-visible:ring-offset-2 focus-visible:ring-offset-background-100 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_span]:min-w-0 [&_span]:truncate";

// Set the color inline (rather than via a `text-*` utility) so it wins over
// the docs layout's global anchor color, which otherwise overrides it on this
// lone `<a>`. The icon is `fill="currentColor"`, so it inherits this too.
const color = "var(--ds-gray-800)";

const trimSlashes = (value: string) => value.replace(/^\/+|\/+$/g, "");

/**
 * Footer action linking to a docs page's source file on GitHub.
 *
 * `path` is the page's source path relative to the docs content directory
 * (e.g. `connections/mcp.mdx`), which is the repo-root `docs/` directory — so
 * the GitHub path is `docs/${path}`.
 */
export const EditOnGithubAction = ({ path }: { path: string }) => {
  const branch = github.branch ?? "main";
  const filePath = `docs/${trimSlashes(path)}`;
  const url = `https://github.com/${github.owner}/${github.repo}/blob/${branch}/${filePath}`;
  return (
    <a
      className={actionClassName}
      href={url}
      rel="noopener noreferrer"
      style={{ color }}
      target="_blank"
    >
      <SiGithub className="size-3.5" style={{ color }} />
      <span>Edit this page on GitHub</span>
    </a>
  );
};
