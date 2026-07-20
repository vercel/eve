import { describe, expect, it } from "vitest";

import { renderBlockLines, type Block } from "./blocks.js";
import { groupToolBlocksForDisplay } from "./tool-block-groups.js";
import { stripAnsi } from "#cli/ui/terminal-text.js";
import { createTheme } from "./theme.js";

const theme = createTheme({ color: false, unicode: true });

describe("subagent section rendering", () => {
  it("renders a settled section MRU-down with grouped errors and a closing corner", () => {
    const call = "call-3";
    const tool = (over: Partial<Block>): Block => ({
      kind: "subagent-tool",
      subagentCallId: call,
      depth: 1,
      live: false,
      status: "done",
      ...over,
    });
    const search = (n: number) =>
      tool({
        title: `Search q${n}`,
        toolName: "web_search",
        toolGroup: {
          verb: "Search",
          pastVerb: "Searched",
          singularNoun: "query",
          pluralNoun: "queries",
          item: `q${n}`,
        },
      });
    const fetchTool = (n: number, over: Partial<Block> = {}) =>
      tool({
        title: `Fetch url${n}`,
        toolName: "fetch_url",
        toolGroup: {
          verb: "Fetch",
          pastVerb: "Fetched",
          singularNoun: "URL",
          pluralNoun: "URLs",
          item: `url${n}`,
        },
        ...over,
      });

    const blocks: Block[] = [
      { kind: "subagent", subagentCallId: call, title: "agent", subtitle: "#3", live: true },
      ...Array.from({ length: 10 }, (_, i) => search(i)),
      fetchTool(1),
      fetchTool(2),
      fetchTool(3),
      fetchTool(99, { status: "error", result: "Response too large (exceeds 5 MB limit)." }),
      tool({ title: "Update todo list", subtitle: "3 tasks", toolName: "todo" }),
      {
        kind: "subagent-step",
        subagentCallId: call,
        depth: 1,
        body: "# Vercel eve competitive capability comparison",
        collapsed: true,
        live: false,
      },
    ];

    // The renderer stamps every block it pushes; mirror that here so the
    // MRU window has real recency to rank on.
    blocks.forEach((block, index) => {
      block.updateSeq = index + 1;
    });
    const rows = groupToolBlocksForDisplay(blocks).flatMap((group) =>
      renderBlockLines(group.display, 78, theme, { activityPulse: "▪" }).map(stripAnsi),
    );

    // A live section shows only its most recently active row; everything
    // earlier waits behind the elision (the completed footnote carries the
    // full counted story).
    expect(rows).toEqual([
      "  ※ subagent(self:3)",
      "  │  … (15 more)",
      "  └ # Vercel eve competitive capability comparison",
    ]);
  });
});
