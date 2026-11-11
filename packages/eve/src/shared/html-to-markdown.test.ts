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
      "<svg viewBox='0 0 1 1'/>",
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
    expect(convertHtmlToMarkdown('<ol start="100000000000"><li>One</ol>')).toBe("1. One");
  });

  it("stops nesting quote and list prefixes past eight levels", () => {
    expect(convertHtmlToMarkdown("<blockquote>".repeat(12) + "x<br>y")).toBe(
      `${"> ".repeat(8)}x\n${"> ".repeat(8)}y`,
    );
    expect(convertHtmlToMarkdown("<ul><li>".repeat(10) + "a<br>b")).toBe(
      `${"- ".repeat(10)}a\n${"  ".repeat(8)}b`,
    );
  });

  it("keeps block structure inside custom and inline elements", () => {
    expect(
      convertHtmlToMarkdown(
        "<turbo-frame><h1>Title</h1><span><ul><li>a<li>b</ul></span><pre><code>x\n  y</code></pre></turbo-frame>",
      ),
    ).toBe("# Title\n\n- a\n- b\n\n```\nx\n  y\n```");
    expect(convertHtmlToMarkdown('<a href="/post"><h2>Title</h2><p>Summary</p></a>')).toBe(
      "[Title Summary](/post)",
    );
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

  it("converts simple tables and renders tables with block content as blocks", () => {
    expect(
      convertHtmlToMarkdown(
        "<table><thead><tr><th>Name<th>Value<tbody><tr><td>a|b<td>1<tr><td>c</table>",
      ),
    ).toBe("| Name | Value |\n| --- | --- |\n| a\\|b | 1 |\n| c |  |");
    expect(
      convertHtmlToMarkdown(
        "<table><tr><td>1<br>2</td><td><pre>def f():\n  return 1</pre></td></tr></table>",
      ),
    ).toBe("1\n2\n\n```\ndef f():\n  return 1\n```");
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
      "<blockquote>".repeat(127) + "x<br>".repeat(400_000),
      '<ol start="999999999"><li>'.repeat(63) + "x<br>".repeat(400_000),
      "<div>" + "<p>x</p>".repeat(200_000),
    ];
    for (const html of inputs) {
      const started = performance.now();
      convertHtmlToMarkdown(html);
      expect(performance.now() - started).toBeLessThan(2_000);
    }
    expect(convertHtmlToMarkdown("<div>".repeat(1_000) + "deep")).toBe("deep");
  });
});
