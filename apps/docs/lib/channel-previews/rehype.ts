import { channelPreviews } from "./scenes";

interface Node {
  type: string;
  tagName?: string;
  children?: Node[];
}

/** The scene key whose page is `path`, such as `channels/slack` for `.../docs/channels/slack/index.mdx`. */
export const channelPreviewSlug = (path: string): string | undefined => {
  const file = path.replaceAll("\\", "/").replace(/(\/index)?\.mdx?$/, "");
  return Object.keys(channelPreviews).find((slug) => file.endsWith(`/docs/${slug}`));
};

/**
 * Places `<ChannelPreview />` before the first section heading of a page with
 * a scene, under its intro. Rehype runs after the processed Markdown export,
 * so `.md` routes, `llms-full.txt`, and the MDX packaged with `eve` never
 * contain it.
 */
export function rehypeChannelPreview() {
  return (tree: Node, file: { path?: string }) => {
    const slug = file.path ? channelPreviewSlug(file.path) : undefined;
    if (!slug || !tree.children) return;
    const preview = {
      type: "mdxJsxFlowElement",
      name: "ChannelPreview",
      attributes: [{ type: "mdxJsxAttribute", name: "slug", value: slug }],
      children: [],
    };
    const heading = tree.children.findIndex((node) => node.tagName === "h2");
    tree.children.splice(heading === -1 ? tree.children.length : heading, 0, preview);
  };
}
