import {
  buyTool,
  buyToolDefinition,
  stripLinks,
  type BuyDeliveryAddress,
  type BuyToolInput,
  type BuyToolModelProduct,
  type BuyToolModelView,
  type BuyToolProduct,
  type BuyToolResult,
} from "@agent-cards/commerce-sdk";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { agentcardClient } from "@/lib/commerce/agentcard";
import { agentcardThreadId } from "@/agent/lib/agentcard/thread";
import { scopeFromPrincipal } from "@/agent/lib/principal-scope";
import { readUserProfile } from "@/lib/shoppers/profile";
import { env } from "@/lib/environment/env";
import type { UserProfile } from "@/lib/shoppers/profile-schema";

const definition = buyToolDefinition();

function defineAgentcardBuy() {
  return defineTool({
    availableInSubagents: false,
    description: `${definition.description}\n\nThe user sees nothing from this tool: your send_message reply is the only message. Put each \`links_to_send\` URL in the \`links\` of the one send_message that says what it is for, so the message and its link go out in a single call. \`product_links\` holds the store page (\`url\`) of each product, by \`product_id\`: put the pages of the products you list in that message's \`links\`, and do not attach product photos. When \`status\` is \`approval_sent\` but \`next_action\` is not \`approve\`, there is no payment to approve yet: ask for what \`next_action\` names, such as the shipping address, and do not tell the user to approve. When \`reply\` says the user must sign in to a store, send its \`store_login\` link rather than shipped substitutes; if no \`store_login\` link came back, call again once with the same \`ask\` to get it.\n\nThis tool confirms a single ready cart itself, so a purchase normally comes back as \`approval_sent\` with its approval link. The approval link, which shows the final total, is the shopper's confirmation: never ask them to say yes to a cart, even where the instructions above say to. Ask about a cart only when \`next_action\` is still \`confirm\`, such as carts at more than one store.`,
    inputSchema: definition.input_schema,
    label: { start: () => "Shop with Agentcard" },
    async execute(input, context) {
      const caller = context.session.auth.current ?? context.session.auth.initiator;
      if (!caller) throw new Error("Shopping requires an authenticated user.");
      const scope = scopeFromPrincipal(caller);
      const threadId = agentcardThreadId(context.session.auth, context.session.id);
      const client = agentcardClient();
      if (!client) throw new Error("Agentcard is not configured.");
      // Every product this call's searches found, for an alternative the
      // reply offers from a search the answer's products no longer hold.
      const heard: BuyToolProduct[] = [];
      // Agentcard keeps the purchase per user and conversation, so a tool
      // built for each call buys the same way as a kept one.
      const options: Parameters<typeof buyTool>[0] = {
        ack: "none",
        agentcard: client,
        externalUserId: scope.userId,
        onProducts: (products) => {
          heard.push(...products);
        },
        threadId,
      };
      // With the saved address, Agentcard ships there and never asks for it;
      // without one, Agentcard asks the user.
      const deliveryAddress = deliveryAddressFrom(await readUserProfile(scope));
      if (deliveryAddress) options.deliveryAddress = deliveryAddress;
      const buy = buyTool(options);
      const sentDeliveryAddress = Boolean(deliveryAddress);
      // Each Agentcard answer, logged with how long it took.
      const answer = async (
        attempt: Parameters<typeof logPurchaseTurn>[0],
        value: BuyToolInput,
      ) => {
        const started = performance.now();
        const answered = await buy.answer(value);
        logPurchaseTurn(attempt, answered, {
          durationMs: Math.round(performance.now() - started),
          modelProducts: buy.forModel(answered).products.length,
          sentDeliveryAddress,
          threadId,
        });
        return answered;
      };
      let result = await answer("ask", buy.parse(input));
      // A later cart in the same conversation can lose the address the
      // shopper gave, and Agentcard then answers `approval_sent` while still
      // naming `shipping_details`: that approval cannot place the order.
      // Sending the address again makes Agentcard name `approve` with a
      // working link.
      //
      // A cart that is ready to place is confirmed here rather than sent back
      // for a chat yes: asking for the purchase and answering its questions is
      // the shopper's go-ahead, and the approval link, which shows the final
      // total and charges nothing until tapped, is their consent to pay
      // (Agentcard: "Take the approval from the approval link as the
      // approval."). A confirm that reprices the cart with fees asks again,
      // so the cap allows one more; the address goes again at most once.
      let confirms = 0;
      let resentAddress = false;
      /* oxlint-disable eslint/no-await-in-loop -- Each purchase step answers the cart the previous one left. */
      for (;;) {
        if (deliveryAddress && !resentAddress && awaitsShipping(result)) {
          resentAddress = true;
          result = await answer(
            "shipping_retry",
            buy.parse({
              ask: shippingAsk(deliveryAddress),
              confirm: false,
              new_order: false,
              product_id: null,
              store_id: null,
            }),
          );
        } else if (confirms < 2 && readyToPlace(result)) {
          confirms++;
          result = await answer(
            "auto_confirm",
            buy.parse({
              ask: "Yes, place it.",
              confirm: true,
              new_order: false,
              product_id: null,
              store_id: null,
            }),
          );
        } else {
          break;
        }
      }
      /* oxlint-enable eslint/no-await-in-loop */
      const view: BuyToolModelView & {
        links_to_send?: ReturnType<typeof stepLinks>;
        product_links?: ReturnType<typeof productLinks>;
      } = buy.forModel(result);
      const named = productsNamedOnlyInReply(result, view, heard);
      if (named.length > 0) {
        view.products = [...view.products, ...named.map(modelProduct)];
        console.info("[agentcard] reply products recovered", {
          conversationId: result.conversation_id,
          recovered: named.length,
          threadId,
        });
      }
      const links = stepLinks(result);
      if (links.length > 0) view.links_to_send = links;
      const products = productLinks(result, view, named);
      if (products.length > 0) view.product_links = products;
      return view;
    },
  });
}

function deliveryAddressFrom(profile: UserProfile): BuyDeliveryAddress | undefined {
  const { addressLine1, city, postalCode, region } = profile;
  if (!addressLine1 || !city || !region || !postalCode) return undefined;
  const address: BuyDeliveryAddress = {
    city,
    state: region,
    street: addressLine1,
    zip: postalCode,
  };
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ");
  if (name) address.name = name;
  if (profile.addressLine2) address.address2 = profile.addressLine2;
  if (profile.phone) address.phone = profile.phone;
  if (profile.countryCode) address.country = profile.countryCode;
  return address;
}

// The card, approval, and store sign-in pages the user opens to go on.
function stepLinks(result: BuyToolResult) {
  return result.links.flatMap((link) =>
    link.url && link.kind !== "product" && link.kind !== "store"
      ? [{ expires_at: link.expiresAt, kind: link.kind, url: link.url }]
      : [],
  );
}

// An approval Agentcard opened for a cart that still has no address: the SDK
// drops its link, and approving it would fail at placement anyway.
function awaitsShipping(result: BuyToolResult) {
  return result.status === "approval_sent" && result.next_action === "shipping_details";
}

// One cart waiting only for the yes that sends its approval link. Carts at
// several stores need the shopper to pick one, a cart the store is still
// building has no total yet, and an open choice still needs their answer.
function readyToPlace(result: BuyToolResult) {
  return (
    result.status === "needs_input" &&
    result.next_action === "confirm" &&
    result.carts.length === 1 &&
    !result.cart_building &&
    !result.choice
  );
}

// The shopper's yes with the saved address written out, in the form Agentcard
// reads into the cart: "Yes, ship to 201 Mission St #3, San Francisco, CA
// 94105, phone ...".
function shippingAsk(address: BuyDeliveryAddress) {
  const street = [address.street, address.address2].filter(Boolean).join(" ");
  const parts = [
    address.name,
    street,
    address.city,
    `${address.state} ${address.zip}`,
    address.country,
  ].filter(Boolean);
  const phone = address.phone ? `, phone ${address.phone}` : "";
  return `Yes, ship to ${parts.join(", ")}${phone}.`;
}

// The fields of Agentcard's raw answer that say which step it named, read
// before the SDK reshapes them, so a turn's log shows what Agentcard sent.
const turnOutlineSchema = z.object({
  approval_url: z.string().nullish().catch(null),
  decline_code: z.string().nullish().catch(null),
  next_action: z.string().nullish().catch(null),
  status: z.string().nullish().catch(null),
});

// One line per Agentcard answer: its raw step beside the SDK's, whether an
// approval link reached the agent, how many products the SDK result holds
// beside how many the model sees, and how long Agentcard took to answer. `attempt` is `ask` for the agent's call,
// `shipping_retry` for the call that sends the saved address again, and
// `auto_confirm` for the confirm the tool sends for a ready cart. Links
// carry one-time tokens, so the line says only whether each one was there.
function logPurchaseTurn(
  attempt: "ask" | "auto_confirm" | "shipping_retry",
  result: BuyToolResult,
  {
    durationMs,
    modelProducts,
    sentDeliveryAddress,
    threadId,
  }: {
    durationMs: number;
    modelProducts: number;
    sentDeliveryAddress: boolean;
    threadId: string;
  },
) {
  const raw = turnOutlineSchema.safeParse(result.envelope);
  const envelope = raw.success ? raw.data : null;
  console.info("[agentcard] purchase turn", {
    approvalLinkSent: stepLinks(result).some((link) => link.kind === "approval"),
    attempt,
    conversationId: result.conversation_id,
    durationMs,
    modelProducts,
    products: result.products.length,
    rawDeclineCode: envelope?.decline_code ?? null,
    rawHasApprovalUrl: Boolean(httpsUrl(envelope?.approval_url)),
    rawNextAction: envelope?.next_action ?? null,
    rawStatus: envelope?.status ?? null,
    sdkNextAction: result.next_action,
    sdkStatus: result.status,
    sentDeliveryAddress,
    threadId,
  });
}

// The store page of each product the model reads, listed or in a cart, so the
// agent can send it as a link. The model sees only its product ids otherwise,
// and Agentcard's own reply never carries a link. A cart's answer usually
// lists no products, so its lines carry the page of the item being bought.
function productLinks(result: BuyToolResult, view: BuyToolModelView, named: BuyToolProduct[]) {
  const known = [...result.products, ...named];
  const lines = result.carts.flatMap((cart) => cart.items);
  const ids = [
    ...view.products.map((product) => product.product_id),
    ...view.carts.flatMap((cart) => cart.items.map((item) => item.product_id)),
  ];
  const links = new Map<string, string>();
  for (const productId of ids) {
    if (!productId || links.has(productId)) continue;
    const product = known.find(
      (candidate) => candidate.ref === productId || candidate.id === productId,
    );
    const line = lines.find(
      (candidate) => candidate.ref === productId || candidate.product_id === productId,
    );
    const url = httpsUrl(product?.url) ?? httpsUrl(line?.url);
    if (url) links.set(productId, url);
  }
  return [...links].map(([productId, url]) => ({ product_id: productId, url }));
}

// Agentcard's reply can offer a product found by an earlier search of the
// same call while the answer's products hold only the last search, which
// leaves the agent with no page to send for it. A product the call heard joins
// the view when the reply names its price and at least two words of its name,
// the best match for each price, and it has a page and a store to name.
function productsNamedOnlyInReply(
  result: BuyToolResult,
  view: BuyToolModelView,
  heard: BuyToolProduct[],
) {
  if (heard.length === 0) return [];
  const reply = stripLinks(result.reply).toLowerCase();
  const replyWords = new Set(wordsOf(reply));
  const known = new Set([
    ...view.products.map((product) => product.product_id),
    ...result.products.flatMap((product) => [product.ref, product.id]),
  ]);
  const best = new Map<string, { product: BuyToolProduct; score: number }>();
  for (const product of heard) {
    const productId = modelProductId(product);
    if (!productId || known.has(productId) || known.has(product.id)) continue;
    const price = priceOf(product);
    if (!price || !product.store || !httpsUrl(product.url)) continue;
    if (!reply.includes(price.toLowerCase())) continue;
    const storeWords = new Set(wordsOf(product.store.toLowerCase()));
    const score = new Set(
      wordsOf(product.name.toLowerCase()).filter(
        (word) =>
          word.length >= 4 &&
          !GENERIC_NAME_WORDS.has(word) &&
          !storeWords.has(word) &&
          replyWords.has(word),
      ),
    ).size;
    const current = best.get(price);
    if (score >= 2 && (!current || score > current.score)) {
      best.set(price, { product, score });
    }
  }
  return [...best.values()].map(({ product }) => product);
}

const GENERIC_NAME_WORDS = new Set(["count", "from", "includes", "pack", "with"]);

function wordsOf(text: string) {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// The id the model passes back for a product, never a link (the SDK's pickId).
function modelProductId(product: BuyToolProduct) {
  for (const id of [product.ref, product.id]) {
    if (id && stripLinks(id) === id) return id;
  }
  return null;
}

// The price as the reply and the model view write it, such as `$29.99`.
function priceOf(product: BuyToolProduct) {
  if (product.priceCents === null || !product.currency) return null;
  try {
    const format = new Intl.NumberFormat("en-US", {
      currency: product.currency.toUpperCase(),
      style: "currency",
    });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(product.priceCents / 10 ** digits);
  } catch {
    return null;
  }
}

function modelProduct(product: BuyToolProduct): BuyToolModelProduct {
  return {
    link_sent: false,
    name: product.name,
    price: priceOf(product),
    product_id: modelProductId(product),
    store: product.store ?? "",
  };
}

// send_message takes only HTTPS links.
function httpsUrl(value: string | null | undefined) {
  if (!value || !URL.canParse(value)) return null;
  return new URL(value).protocol === "https:" ? value : null;
}

export default defineDynamic(() => {
  if (!env.AGENTCARD_CLIENT_ID || !env.AGENTCARD_CLIENT_SECRET) return null;
  return { "agentcard-buy": defineAgentcardBuy() };
});
