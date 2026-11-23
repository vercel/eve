import assert from "node:assert/strict";
import test from "node:test";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { parsePublicResearchPage, renderPublicResearchPreview } from "./public-preview.ts";

const merchant = new URL("https://shop.example.com/products/kettle");

test("public research keeps product text and images without form, hidden, or embedded content", () => {
  const research = parsePublicResearchPage(
    `
    <title>Copper kettle</title><meta property="og:image" content="/kettle.png">
    <main>
      <h1>Copper kettle</h1><p>In stock</p><a href="/products/kettle-lid">Replacement lid</a>
      <a href="http://shop.example.com/catalog">Non-HTTPS catalog</a>
      <form><label>Example private form value</label><input value="example form field"></form>
      <p hidden>Not visible</p><div contenteditable>Editable content</div>
      <iframe srcdoc="<p>Embedded content</p>"></iframe><script>siteScript()</script>
    </main>`,
    merchant,
  );
  assert.equal(research.title, "Copper kettle");
  assert.equal(research.text, "Copper kettle In stock Replacement lid Non-HTTPS catalog");
  assert.deepEqual(research.links, ["https://shop.example.com/products/kettle-lid"]);
  assert.equal(research.imageUrl, "https://shop.example.com/kettle.png");
});

test("the screenshot document renders public page data as text, not a merchant DOM", () => {
  const research = parsePublicResearchPage(
    `
    <title>Kettle &amp; lid</title><p>Label: &lt;button&gt;Buy&lt;/button&gt;</p>
    <form><input autocomplete="one-time-code" value="000000"></form>`,
    merchant,
  );
  const stack: DefaultTreeAdapterMap["node"][] = [parse(renderPublicResearchPreview(research))];
  const tags: string[] = [];
  const text: string[] = [];
  while (stack.length) {
    const node = stack.pop();
    if (!node) break;
    if ("tagName" in node) tags.push(node.tagName);
    if ("value" in node) text.push(node.value);
    if ("childNodes" in node) stack.push(...node.childNodes);
  }
  assert.ok(tags.includes("main"));
  assert.ok(!tags.some((tag) => ["form", "input", "button", "iframe", "script"].includes(tag)));
  assert.ok(text.includes("Kettle & lid"));
  assert.ok(text.includes("Label: <button>Buy</button>"));
  assert.ok(!text.some((value) => value.includes("000000")));
});
