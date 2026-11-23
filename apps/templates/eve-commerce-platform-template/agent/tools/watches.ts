import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { scopeFromPrincipal } from "@/agent/lib/principal-scope";
import { directLinqChatId } from "@/lib/linq/transport";
import { readProductOffer } from "@/lib/watches/product-page";
import { productUrl } from "@/lib/watches/product-url";
import { createWatch, listWatches, stopWatch, watchLifetimeDays } from "@/lib/watches/store";

const productFields = {
  productName: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((name) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)),
  productUrl: z.string().max(2048),
};
const createInput = z.discriminatedUnion("kind", [
  z.strictObject({ ...productFields, kind: z.literal("restock") }),
  z.strictObject({
    ...productFields,
    kind: z.literal("price"),
    targetUsd: z
      .string()
      .regex(/^\d{1,7}(?:\.\d{1,2})?$/)
      .refine((value) => Number(value) > 0)
      .describe(
        "The shopper’s maximum price in US dollars, e.g. 24.99, excluding tax and shipping.",
      ),
  }),
]);

export default defineDynamic((ctx) => {
  const caller = ctx.session.auth.current;
  if (caller?.principalType !== "user" || caller.authenticator !== "linq-message") return null;
  const threadId = caller.attributes.linqThreadId;
  if (
    typeof threadId !== "string" ||
    threadId !== caller.attributes.conversationId ||
    !directLinqChatId(threadId)
  )
    return null;
  const scope = scopeFromPrincipal(caller);

  return {
    "watches-start": defineTool({
      availableInSubagents: false,
      description:
        "Start one read-only shopping watch for an exact public merchant product link the shopper explicitly wants to track. Price watches require a USD target; restock watches alert when listed in stock. Sends one iMessage alert, then stops. Does not buy or use accounts. Watches expire after 30 days.",
      inputSchema: createInput,
      async execute(input) {
        const url = productUrl(input.productUrl).href;
        const offer = await readProductOffer(url).catch(() => undefined);
        if (!offer || (input.kind === "price" && offer.usdCents === null)) {
          return {
            started: false,
            reason:
              "I couldn't verify a single offer on that product page. Send a public product link that lists stock and, for a price watch, a USD price.",
          } as const;
        }
        const watch = await createWatch(scope, {
          kind: input.kind,
          productName: input.productName,
          productUrl: url,
          targetUsdCents: input.kind === "price" ? Math.round(Number(input.targetUsd) * 100) : null,
          threadId,
        });
        return { started: true, id: watch.id, expiresAfterDays: watchLifetimeDays } as const;
      },
    }),
    "watches-list": defineTool({
      availableInSubagents: false,
      description:
        "List all active price and restock watches, followed by recent history. Use to identify a watch before stopping it.",
      inputSchema: z.strictObject({}),
      execute: () => listWatches(scope),
    }),
    "watches-stop": defineTool({
      availableInSubagents: false,
      description:
        "Stop one of this shopper’s active watches. Use an ID from watches-list, never guess it.",
      inputSchema: z.strictObject({ id: z.uuid() }),
      async execute({ id }) {
        return { stopped: await stopWatch(scope, id) };
      },
    }),
  };
});
