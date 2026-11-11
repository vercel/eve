import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks, stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { compileScript, parse } from "vue/compiler-sfc";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";

// Supply Nuxt's auto-import and compile the real source-link SFC without booting Nuxt.
const require = createRequire(import.meta.url);
const comarkRequire = createRequire(require.resolve("@comark/nuxt"));
const comarkVueUrl = pathToFileURL(comarkRequire.resolve("@comark/vue")).href;
const componentUrl = new URL("../apps/web/app/components/chat/Comark.ts", import.meta.url);
registerHooks({
  load(url, context, nextLoad) {
    if (url === componentUrl.href) {
      return {
        format: "module",
        source: `import { defineMarkdownComponent } from ${JSON.stringify(comarkVueUrl)};\n${readFileSync(new URL(url), "utf8")}`,
        shortCircuit: true,
      };
    }
    if (url.endsWith(".vue")) {
      const { descriptor } = parse(readFileSync(new URL(url), "utf8"));
      const compiled = compileScript(descriptor, { id: url, inlineTemplate: true });
      return {
        format: "module",
        source: stripTypeScriptTypes(compiled.content),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
const { default: ChatComark } = await import(componentUrl.href);

async function render(value, streaming = false) {
  const app = createSSRApp({ render: () => h(ChatComark, { value, streaming }) });
  app.component("UButton", {
    props: ["to", "label"],
    setup: (props) => () => h("a", { href: props.to }, props.label),
  });
  return renderToString(app);
}

for (const streaming of [false, true]) {
  test(`chat Markdown removes executable HTML and component syntax (streaming=${streaming})`, async () => {
    for (const value of [
      '<script>alert("xss")</script>',
      '<script>alert("streaming")',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      '<svg><animate onbegin="alert(1)" /></svg>',
      '::script\nalert("xss")\n::',
      '::u-button{to="javascript:alert(1)"}\nClick\n::',
    ]) {
      const output = await render(value, streaming);
      assert.doesNotMatch(output, /<(?:script|iframe|svg|animate|u-button)\b/i);
      assert.doesNotMatch(output, /(?:href|src)="\s*javascript:/i);
    }
    for (const value of [
      '<img src="https://example.com/image.png" onerror="alert(1)">',
      "[Click](javascript:alert%281%29)",
      '<a href="javascript:alert(1)">Click</a>',
      '<a href="java&#x73;cript:alert(1)">Click</a>',
      '::span{innerHTML="<img src=x onerror=alert(1)>"}\n::',
      ':img{src="data:image/svg+xml,test"}',
      '---\nx: data:image/svg+xml,test\n---\n:img{:src="frontmatter.x"}',
      ':source-link{url="javascript:alert(1)" favicon="https://example.com/favicon.ico" label="Click" onmouseover="alert(1)"}',
    ]) {
      const output = await render(value, streaming);
      assert.doesNotMatch(
        output,
        /<[^>]*\s(?:on\w+|innerhtml)=|(?:href|src)="\s*(?:javascript|data):/i,
      );
    }
  });
}

test("chat Markdown escapes raw HTML without dropping its text", async () => {
  const output = await render(
    "<b>Bold</b> and <sup>2</sup>\n\n<details><summary>Summary</summary>Important content</details>",
  );
  assert.match(output, /&lt;b&gt;Bold&lt;\/b&gt;/);
  assert.match(output, /&lt;sup&gt;2&lt;\/sup&gt;/);
  assert.match(output, /Important content/);
  assert.doesNotMatch(output, /<(?:b|sup|details|summary)\b/);
});

test("chat Markdown preserves formatting, highlighted code, and source links", async () => {
  const output = await render(
    '# Heading\n\n**Bold** and [link](https://example.com).\n\n- [x] Done\n\n| Name |\n| --- |\n| Alice |\n\n```html\n<script>alert("example")</script>\n```\n\n:source-link{url="https://example.com" favicon="https://example.com/favicon.ico" label="example.com"}',
  );
  assert.match(output, /<h1\b[^>]*>Heading<\/h1>/);
  assert.match(output, /<strong>Bold<\/strong>/);
  assert.match(output, /href="https:\/\/example.com"/);
  assert.match(output, /<input\b[^>]*type="checkbox"/);
  assert.match(output, /<table\b/);
  assert.match(output, /<pre\b/);
  assert.match(output, /<span\b/);
  assert.match(output, /&lt;/);
  assert.doesNotMatch(output, /<script\b/);
  assert.match(output, /<a\b[^>]*href="https:\/\/example.com"[^>]*>example.com<\/a>/);
});
