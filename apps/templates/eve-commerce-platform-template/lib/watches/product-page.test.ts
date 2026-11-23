import assert from "node:assert/strict";
import test from "node:test";
import { evaluateWatch } from "./match.ts";
import { parseProductOffer } from "./product-page.ts";
import { isPublicAddress, productUrl } from "./product-url.ts";

const watch = {
  kind: "price",
  productName: "Desk lamp",
  productUrl: "https://store.example.com/lamp",
  targetUsdCents: 2500,
} as const;
const offer = {
  "@type": "Offer",
  availability: "https://schema.org/InStock",
  priceCurrency: "USD",
  price: "25.00",
};
const html = (item: unknown) =>
  `<script type='application/ld+json'>${JSON.stringify(item)}</script>`;
const parseOffer = (item: unknown, url: string = watch.productUrl) =>
  parseProductOffer(html(item), new URL(url));

test("matches an in-stock USD offer at the shopper’s threshold", () => {
  const priced = parseOffer({ "@graph": [{ "@type": "Product", offers: offer }] });
  assert.deepEqual(priced, { inStock: true, usdCents: 2500 });
  assert.deepEqual(evaluateWatch(watch, priced), {
    alert:
      "Desk lamp is listed in stock at $25.00 before tax and shipping.\nhttps://store.example.com/lamp",
  });
  assert.equal(evaluateWatch(watch, { inStock: true, usdCents: 2501 }), "no_match");
});

test("does not alert on an ambiguous offer, preorder, or other currency", () => {
  const product = { "@type": "Product", offers: offer };
  for (const item of [
    { "@graph": [product, product] },
    { ...product, offers: [offer, { ...offer, price: "30" }] },
    { ...product, "@type": ["Product", "ProductGroup"] },
    { ...product, offers: { ...offer, "@type": "AggregateOffer" } },
  ])
    assert.equal(parseOffer(item), undefined);

  const preorder = parseOffer({ ...product, offers: { ...offer, availability: "PreOrder" } });
  assert.equal(evaluateWatch({ ...watch, kind: "restock" }, preorder), "no_match");
  const otherCurrency = parseOffer({ ...product, offers: { ...offer, priceCurrency: "CAD" } });
  assert.equal(evaluateWatch(watch, otherCurrency), "unreadable");
  assert.deepEqual(evaluateWatch({ ...watch, kind: "restock" }, otherCurrency), {
    alert: "Desk lamp is listed in stock.\nhttps://store.example.com/lamp",
  });
});

test("requires a selected product variant to match the offer URL", () => {
  const variantUrl = `${watch.productUrl}?variant=12`;
  assert.equal(parseOffer({ "@type": "Product", offers: offer }, variantUrl), undefined);
  assert.equal(
    parseOffer({ "@type": "Product", offers: { ...offer, url: "/lamp?variant=13" } }, variantUrl),
    undefined,
  );
  assert.equal(
    parseOffer({ "@type": "Product", offers: { ...offer, url: "/other?variant=12" } }, variantUrl),
    undefined,
  );
  assert.deepEqual(
    parseOffer(
      { "@type": "Product", offers: { ...offer, url: "/lamp?variant=12" } },
      `${variantUrl}&utm_source=text`,
    ),
    { inStock: true, usdCents: 2500 },
  );
});

test("limits watches to public HTTPS page URLs and public addresses", () => {
  assert.equal(
    productUrl("https://shop.example.com/lamp?variant=1#photos").href,
    "https://shop.example.com/lamp?variant=1",
  );
  for (const url of [
    "http://store.example.com/lamp",
    "https://user@store.example.com/lamp",
    "https://store.example.com:444/lamp",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://[::1]/",
    "https://intranet.internal/",
  ]) {
    assert.throws(() => productUrl(url), /public HTTPS/);
  }
  for (const address of [
    "127.0.0.1",
    "169.254.169.254",
    "10.0.0.1",
    "192.168.0.1",
    "100.64.0.1",
    "0.0.0.0",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPublicAddress(address), false);
  }
  assert.equal(isPublicAddress("1.1.1.1"), true);
});
