import type { ProductOffer } from "./product-page.ts";

interface WatchCondition {
  readonly kind: "price" | "restock";
  readonly productName: string;
  readonly productUrl: string;
  readonly targetUsdCents: number | null;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function evaluateWatch(watch: WatchCondition, offer: ProductOffer | undefined) {
  if (!offer || (watch.kind === "price" && offer.usdCents === null)) return "unreadable" as const;
  if (!offer.inStock) return "no_match" as const;
  if (watch.kind === "restock")
    return { alert: `${watch.productName} is listed in stock.\n${watch.productUrl}` };
  if (
    offer.usdCents === null ||
    watch.targetUsdCents === null ||
    offer.usdCents > watch.targetUsdCents
  )
    return "no_match" as const;
  return {
    alert: `${watch.productName} is listed in stock at ${usd.format(offer.usdCents / 100)} before tax and shipping.\n${watch.productUrl}`,
  };
}
