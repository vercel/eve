import { agentcardWebhook, type ShopperMessage } from "@agent-cards/commerce-sdk";
import { defineChannel, POST, type AttachSessionFn } from "eve/channels";
import { SessionNotActiveError } from "eve/client";
import type { ScheduleToFn } from "eve/schedules";
import { agentcardClient } from "@/lib/commerce/agentcard";
import { agentcardThreadTarget } from "@/agent/lib/agentcard/thread";
import { readAgentcardOrder, saveAgentcardOrder } from "@/lib/commerce/orders";
import { canDeliverToLinqThread } from "@/lib/linq/thread-ownership";
import { isSessionOwned } from "@/lib/sessions/ownership";
import { env } from "@/lib/environment/env";
import { accessScopeForUser, type AccessScope } from "@/lib/auth/scope";
import linq from "./linq-shopper";

// Agentcard posts purchase updates (a saved card, an approval about to expire,
// an order placed) here. Each one becomes a turn in the conversation the
// purchase started in, so the agent tells the shopper or takes the next step.
export default defineChannel({
  routes: [
    POST("/agentcard/webhooks", async (request, { attachSession, to }) => {
      const secret = env.AGENTCARD_WEBHOOK_SECRET;
      if (!secret) return new Response(null, { status: 404 });
      // The handler verifies the signature and drops stale messages. It
      // answers 500 when delivery throws, so Agentcard retries the event.
      return agentcardWebhook({
        secret,
        onMessage: (shopperId, message) =>
          deliverAgentcardMessage({ attachSession, to }, shopperId, message),
        // Every event that carries no message for one of our shoppers lands
        // here: a type other than `purchase.message`, `order.confirmed`, or
        // `order.updated`, or a message without our shopper id. Nothing acts
        // on it, so the log is the only trace it arrived.
        onEvent: (event) => {
          console.info("[agentcard] event with no shopper message", {
            eventId: event.id,
            type: event.type,
          });
        },
      }).fetch(request);
    }),
  ],
});

export async function deliverAgentcardMessage(
  delivery: {
    readonly attachSession: AttachSessionFn;
    readonly to: ScheduleToFn;
  },
  shopperId: string,
  message: ShopperMessage,
) {
  if (!(await approvalStillOpen(shopperId, message))) {
    console.info("[agentcard] dropped a reminder for a closed approval", {
      eventId: message.eventId,
      kind: message.kind,
    });
    return;
  }
  const scope = accessScopeForUser(shopperId);
  const order = await orderOfMessage(scope, shopperId, message);
  const prompt = agentcardUpdatePrompt(message, { order, sessionEnded: false });
  const options = (attributes: Record<string, string>) => ({
    auth: {
      attributes: { ...attributes, workspaceId: scope.workspaceId },
      authenticator: "agentcard-update",
      issuer: "evey",
      principalId: shopperId,
      principalType: "user" as const,
    },
    // Agentcard delivers at least once; the key makes a redelivery a no-op.
    idempotencyKey: `agentcard:${message.eventId}`,
    turnPolicy: "queue" as const,
  });
  const sendToSession = async (sessionId: string, attributes: Record<string, string>) => {
    try {
      const sent = await delivery.attachSession(sessionId).send(prompt, options(attributes));
      console.info("[agentcard] purchase update sent to session", {
        eventId: message.eventId,
        kind: message.kind,
        sent,
        sessionId,
      });
      return true;
    } catch (error) {
      if (!SessionNotActiveError.is(error) || error.code !== "session_not_active") throw error;
      console.info("[agentcard] purchase update for an inactive session", {
        eventId: message.eventId,
        kind: message.kind,
      });
      return false;
    }
  };

  if (!message.threadId) {
    console.warn("[agentcard] no verified destination for purchase update", {
      eventId: message.eventId,
      kind: message.kind,
    });
    return;
  }

  const target = agentcardThreadTarget(message.threadId);
  if (!target || !(await isSessionOwned(scope, target.sessionId))) {
    console.warn("[agentcard] no owned conversation for purchase update", {
      eventId: message.eventId,
      kind: message.kind,
    });
    return;
  }
  if (target.channel === "linq") {
    if (!(await canDeliverToLinqThread(target.threadId, shopperId))) return;
    const attributes = {
      conversationChannel: "linq",
      conversationId: target.threadId,
      linqThreadId: target.threadId,
    };
    // The purchase belongs to the session it started in. Once that session
    // has ended, the update still reaches the iMessage conversation, in
    // whichever session now holds it, but that session never saw the cart.
    if (await sendToSession(target.sessionId, attributes)) return;
    // The user moved on from that conversation, so a reminder about its
    // approval is noise, and its link would restart a purchase they left.
    if (isApprovalReminder(message)) {
      console.info("[agentcard] dropped a reminder from an ended session", {
        eventId: message.eventId,
        kind: message.kind,
      });
      return;
    }
    const sent = await delivery
      .to(linq, { adapterName: "linq", threadId: target.threadId })
      .send(agentcardUpdatePrompt(message, { order, sessionEnded: true }), options(attributes));
    console.info("[agentcard] purchase update sent to Linq thread", {
      eventId: message.eventId,
      kind: message.kind,
      sent,
      sessionEnded: true,
      threadId: target.threadId,
    });
    return;
  }
  await sendToSession(target.sessionId, { conversationChannel: "local" });
}

const approvalReminderKinds = new Set(["approval_expiring", "approval_expired"]);
const conversationReadTimeoutMs = 4000;

function isApprovalReminder(message: ShopperMessage) {
  return approvalReminderKinds.has(message.kind);
}

// Agentcard reminds the user about every approval it opened, including one a
// newer approval replaced or whose purchase closed, and the reminder does not
// say which. The conversation names its latest approval, so a reminder about
// any other is dropped. When the conversation cannot be read, or names no
// approval, the reminder goes out as before rather than risk hiding a live one.
async function approvalStillOpen(shopperId: string, message: ShopperMessage) {
  if (!isApprovalReminder(message)) return true;
  const approvalUrl = message.facts.approvalUrl;
  if (!approvalUrl) return true;
  const conversation = await readConversation(shopperId, message, "reminder");
  if (!conversation) return true;
  if (conversation.status === "closed") return false;
  const latest = conversation.last_checkout?.approval_url;
  return !latest || sameLink(latest, approvalUrl);
}

// Undefined when Agentcard is not configured, the message names no
// conversation, or the read fails; the caller then goes on without it.
async function readConversation(shopperId: string, message: ShopperMessage, purpose: string) {
  const client = agentcardClient();
  if (!message.conversationId || !client) return undefined;
  try {
    // Agentcard waits 10 seconds for the webhook's answer, and the SDK's own
    // read timeout is longer, so the read gets a shorter limit of its own.
    return await Promise.race([
      client.conversation(message.conversationId, {
        externalUserId: shopperId,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("conversation read timed out"));
        }, conversationReadTimeoutMs).unref();
      }),
    ]);
  } catch (error) {
    console.warn(`[agentcard] could not read the conversation of a ${purpose}`, {
      error: error instanceof Error ? error.message : String(error),
      eventId: message.eventId,
    });
    return undefined;
  }
}

// Agentcard's order messages carry no items (the SDK's README says to show
// them "only from what your own app kept"), so the cart is kept when the order
// is placed and read back for every later update about it.
const orderPlacedKinds = new Set(["order_placed", "order_confirmed"]);

async function orderOfMessage(scope: AccessScope, shopperId: string, message: ShopperMessage) {
  const orderId = message.order?.orderId;
  if (!orderId) return undefined;
  try {
    const saved = await readAgentcardOrder(scope, orderId);
    if (saved || !orderPlacedKinds.has(message.kind)) return saved;
    return await keepOrderCart(scope, shopperId, message, orderId);
  } catch (error) {
    console.warn("[agentcard] could not read or keep an order's items", {
      error: error instanceof Error ? error.message : String(error),
      eventId: message.eventId,
    });
    return undefined;
  }
}

async function keepOrderCart(
  scope: AccessScope,
  shopperId: string,
  message: ShopperMessage,
  orderId: string,
) {
  const conversation = await readConversation(shopperId, message, "new order");
  if (!conversation) return undefined;
  const checkout =
    conversation.last_checkout?.order_id === orderId ? conversation.last_checkout : undefined;
  const merchant =
    checkout?.merchant ??
    conversation.orders.find((placed) => placed.order_id === orderId)?.merchant;
  // Only a cart that is plainly this order's is kept: with none, or several at
  // the same store, the items stay unknown rather than guessed.
  const carts = conversation.carts.filter((cart) => cart.merchant === merchant);
  const [cart] = carts;
  if (!merchant || carts.length !== 1 || !cart || cart.items.length === 0) {
    console.info("[agentcard] no single cart to keep for an order", {
      carts: carts.length,
      eventId: message.eventId,
    });
    return undefined;
  }
  const order = {
    items: cart.items.map(({ name, qty }) => ({ name, qty })),
    merchantName: cart.store?.name ?? cart.merchant_name,
    orderId,
    retailerOrderId: message.order?.retailerOrderId ?? message.facts.retailerOrderId ?? null,
  };
  await saveAgentcardOrder(scope, order);
  return order;
}

type KeptOrder = Awaited<ReturnType<typeof orderOfMessage>>;

function orderLine(message: ShopperMessage, kept: KeptOrder) {
  if (!message.order?.orderId) return undefined;
  const retailerOrderId =
    kept?.retailerOrderId ?? message.order.retailerOrderId ?? message.facts.retailerOrderId;
  const number = retailerOrderId ? `, order number ${retailerOrderId}` : "";
  if (kept) {
    const items = kept.items
      .map(({ name, qty }) => (qty > 1 ? `${String(qty)} × ${name}` : name))
      .join("; ");
    return `This update is about the order of ${items} from ${kept.merchantName ?? "the store"}${number}. Name what was bought in your message.`;
  }
  const store = message.order.merchantName ?? message.order.storeName;
  return `This update is about ${store ? `a ${store}` : "an"} order${number}. Which products it holds is not known: name it by its store and order number, and do not guess its products from this conversation.`;
}

// The approval's one-time token is its path; the query can differ by copy.
function sameLink(a: string, b: string) {
  if (!URL.canParse(a) || !URL.canParse(b)) return a === b;
  const [left, right] = [new URL(a), new URL(b)];
  return left.origin === right.origin && left.pathname === right.pathname;
}

function agentcardUpdatePrompt(
  message: ShopperMessage,
  { order, sessionEnded }: { order: KeptOrder; sessionEnded: boolean },
) {
  const tell =
    "Tell the user in one short message. Keep any link exactly as written and put it in that send_message's links, so the message and its link go out in one call.";
  // Agentcard counts a decline as a step that advances the purchase, but the
  // user's decline is a decision to stop, not something to retry for them.
  const nextStep = sessionEnded
    ? `This purchase started in an earlier conversation that has since been reset, so it is not any purchase this conversation talks about. Do not continue it or call \`agentcard-buy\` for it. ${tell}`
    : message.kind === "approval_declined"
      ? `The user declined this payment, so the purchase stops here. Do not call \`agentcard-buy\` or send a new approval link unless the user asks to buy again in a later message. ${tell}`
      : message.advances
        ? "The user just finished this step outside the chat. Take the next step for them now with `agentcard-buy`, without waiting for them to reply: call it with `confirm: false` and `ask` describing what they finished, unless they already said yes to this exact cart earlier in this conversation and the purchase stopped only for this step, in which case call it with `confirm: true`. Then send the result in one short message."
        : tell;
  return [
    "An Agentcard purchase update arrived. The user did not write this message.",
    `Kind: ${message.kind}`,
    message.note ? `What happened: ${message.note}` : undefined,
    `Message prepared for the user: ${message.text}`,
    orderLine(message, order),
    nextStep,
    "Omit send_message.replyTo.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
