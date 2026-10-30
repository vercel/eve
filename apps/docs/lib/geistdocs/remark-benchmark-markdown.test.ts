import { createProcessor } from "@mdx-js/mdx";
import { toMarkdown, type Options } from "mdast-util-to-markdown";
import { describe, expect, it } from "vitest";
import config from "../../source.config";
import { remarkBenchmarkMarkdown } from "./remark-benchmark-markdown";

describe("benchmark Markdown export", () => {
  it.each(["<EveCodeBenchmark />", '<EveCodeBenchmark dataset={"example"} />'])(
    "rejects unsupported dataset attributes: %s",
    (source) => {
      const processor = createProcessor({ remarkPlugins: [remarkBenchmarkMarkdown] });
      const tree = processor.parse(source);
      expect(() =>
        toMarkdown(tree, {
          extensions: (processor.data() as { toMarkdownExtensions?: Options[] })
            .toMarkdownExtensions,
        }),
      ).toThrow("EveCodeBenchmark Markdown export requires a literal dataset string.");
    },
  );
  it("exports results without changing HTML components or fenced examples", async () => {
    const options =
      typeof config.mdxOptions === "function" ? await config.mdxOptions() : config.mdxOptions;
    const plugins = options?.remarkPlugins;
    if (!Array.isArray(plugins)) throw new Error("Expected configured remark plugins");
    const processor = createProcessor({ remarkPlugins: plugins });
    const tree = processor.parse(
      [
        '<EveCodeBenchmark dataset="deepswe-lean" />',
        "",
        "<EveCodeBenchmark",
        '  className="wide"',
        "  dataset='not-published'",
        "/>",
        "",
        "<Callout>Keep this content.</Callout>",
        "",
        "```mdx",
        '<EveCodeBenchmark dataset="deepswe-lean" />',
        "```",
      ].join("\n"),
    );
    const markdown = toMarkdown(tree, {
      extensions: (processor.data() as { toMarkdownExtensions?: Options[] }).toMarkdownExtensions,
    });

    expect(markdown).toContain(
      "| Harness | Resolved | 95% interval | Median latency | p90 latency | Measured |",
    );
    expect(markdown).toContain("No published not-published results yet.");
    expect(markdown).toContain("<Callout>Keep this content.</Callout>");
    expect(markdown).toContain('```mdx\n<EveCodeBenchmark dataset="deepswe-lean" />\n```');
    expect(markdown.match(/<EveCodeBenchmark/g)).toHaveLength(1);
    expect(
      tree.children.filter(
        (node) => node.type === "mdxJsxFlowElement" && node.name === "EveCodeBenchmark",
      ),
    ).toHaveLength(2);
  });
});
