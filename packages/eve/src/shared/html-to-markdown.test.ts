import { describe, expect, it } from "vitest";

import { convertHtmlToMarkdown } from "#shared/html-to-markdown.js";

describe("convertHtmlToMarkdown", () => {
  it("converts headings to ATX-style markdown", () => {
    expect(
      convertHtmlToMarkdown("<h1>Title</h1><h2>Sub <em>title</em></h2><p>Body text.</p>"),
    ).toBe("# Title\n\n## Sub *title*\n\nBody text.");
  });

  it("converts links and images", () => {
    expect(convertHtmlToMarkdown('<a href="https://example.com">Example</a>')).toBe(
      "[Example](https://example.com)",
    );
    expect(
      convertHtmlToMarkdown(
        '<a href="/a b" title="Say &quot;hi&quot;"><img src="x.png" alt="X"></a>',
      ),
    ).toBe('[![X](x.png)](/a%20b "Say \\"hi\\"")');
    expect(convertHtmlToMarkdown("<a>no href</a> <a href='/x'> </a>")).toBe("no href");
  });

  it("removes script, style, meta, link, and other non-content elements", () => {
    const html = [
      "<html><head>",
      '<meta charset="utf-8">',
      '<link rel="stylesheet" href="style.css">',
      "<style>body { color: red; }</style>",
      "</head><body>",
      "<script>if (a < b) alert('</p>')</script>",
      "<noscript>Enable JS</noscript>",
      "<svg><text>icon</text></svg>",
      "<!-- comment -->",
      "<p>Visible content.</p>",
      "</body></html>",
    ].join("");
    expect(convertHtmlToMarkdown(html)).toBe("Visible content.");
  });

  it("renders inline formatting and collapses whitespace", () => {
    expect(
      convertHtmlToMarkdown(
        "<p>  A <strong> bold </strong>, <i>italic</i>,\n <del>gone</del> and <code>a`b</code>.</p>",
      ),
    ).toBe("A **bold** , *italic*, ~~gone~~ and ``a`b``.");
  });

  it("keeps line breaks", () => {
    expect(convertHtmlToMarkdown("<b>status</b><br>please<br/>now")).toBe(
      "**status**\nplease\nnow",
    );
  });

  it("converts unordered, ordered, and nested lists", () => {
    expect(convertHtmlToMarkdown("<ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul>")).toBe(
      "- One\n- Two\n  - Nested",
    );
    expect(convertHtmlToMarkdown('<ol start="3"><li>Three<li>Four</ol>')).toBe("3. Three\n4. Four");
  });

  it("converts fenced code blocks with language and preserved whitespace", () => {
    expect(
      convertHtmlToMarkdown(
        '<pre><code class="language-ts">const x = 1;\n\n  if (x &lt; 2) {}\n</code></pre>',
      ),
    ).toBe("```ts\nconst x = 1;\n\n  if (x < 2) {}\n```");
    expect(convertHtmlToMarkdown("<pre>a ``` b</pre>")).toBe("````\na ``` b\n````");
  });

  it("converts blockquotes and horizontal rules", () => {
    expect(
      convertHtmlToMarkdown("<blockquote><p>One</p><p>Two</p></blockquote><hr><p>After</p>"),
    ).toBe("> One\n>\n> Two\n\n---\n\nAfter");
  });

  it("converts simple tables", () => {
    expect(
      convertHtmlToMarkdown(
        "<table><thead><tr><th>Name<th>Value</thead><tbody><tr><td>a|b<td>1<tr><td>c</table>",
      ),
    ).toBe("| Name | Value |\n| --- | --- |\n| a\\|b | 1 |\n| c |  |");
  });

  it("decodes entities", () => {
    expect(
      convertHtmlToMarkdown("<p>&lt;tag&gt; &amp; &#169; &#x1F600; &bogus; &constructor;</p>"),
    ).toBe("<tag> & © 😀 &bogus; &constructor;");
  });

  it("tolerates malformed markup", () => {
    expect(convertHtmlToMarkdown("<p>a < b</div> c<p>d")).toBe("a < b c\n\nd");
    expect(convertHtmlToMarkdown('<a href="x>y">z</a><p>unterminated <b')).toBe(
      "[z](x%3Ey)\n\nunterminated <b",
    );
  });

  it("stays fast on hostile input", () => {
    const inputs = [
      "<div>".repeat(200_000) + "deep",
      "<b>".repeat(200_000),
      "<br>".repeat(200_000) + "x",
      "<pre>" + " ".repeat(500_000) + "x</pre>",
      "<p>" + "<".repeat(500_000),
      '<a href="'.repeat(100_000),
      "<script>".repeat(100_000),
      "<!--".repeat(100_000),
      "&#".repeat(200_000),
      "<table>" + "<tr><td>x".repeat(100_000) + "</table>",
      "<pre>" + "`".repeat(200_000) + "</pre>",
    ];
    for (const html of inputs) {
      const started = performance.now();
      convertHtmlToMarkdown(html);
      expect(performance.now() - started).toBeLessThan(2_000);
    }
    expect(convertHtmlToMarkdown("<div>".repeat(1_000) + "deep")).toBe("deep");
  });
});
