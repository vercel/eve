import { describe, expect, it } from "vitest";
import { channelPreviewSlug, rehypeChannelPreview } from "./rehype";

describe("rehypeChannelPreview", () => {
  it("matches channel pages and nothing else", () => {
    expect(channelPreviewSlug("/repo/docs/channels/slack/index.mdx")).toBe("channels/slack");
    expect(channelPreviewSlug("C:\\repo\\docs\\channels\\linq\\index.mdx")).toBe("channels/linq");
    expect(channelPreviewSlug("/repo/docs/channels/slack/reference.mdx")).toBeUndefined();
    expect(channelPreviewSlug("/repo/docs/channels/discord/index.mdx")).toBeUndefined();
  });

  it("inserts the preview before the first section heading", () => {
    const tree = {
      type: "root",
      children: [
        { type: "element", tagName: "p" },
        { type: "element", tagName: "p" },
        { type: "element", tagName: "h2" },
      ],
    };
    rehypeChannelPreview()(tree, { path: "/repo/docs/channels/github/index.mdx" });
    expect(tree.children.map((node) => node.tagName ?? node.type)).toEqual([
      "p",
      "p",
      "mdxJsxFlowElement",
      "h2",
    ]);
    expect(tree.children[2]).toMatchObject({
      name: "ChannelPreview",
      attributes: [{ name: "slug", value: "channels/github" }],
    });
  });
});
