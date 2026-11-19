import { defineAgent } from "eve";

export default defineAgent({
  tool: false,
  defaultTools: false,
  description:
    "Research public product pages and optionally return a product image or a safe static preview. No sign-in, cart changes, or checkout.",
  model: "meta/muse-spark-1.3",
  reasoning: "low",
  compaction: { threshold: 0.7 },
});
