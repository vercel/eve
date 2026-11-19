import { defineEval, type ToolStub } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { sendMessageOutputSchema } from "@/lib/messaging/message-delivery";
import { agentEvalTags, assertPlainTextDelivery } from "@/evals/agent/shared";

// Sanitized from a production run (2026-11-07): Agentcard had no RC Tesla
// Roadster, offered two RC Cybertrucks, and returned an unrelated LEGO set
// alongside them. The agent then searched the web and sent an Amazon listing
// Agentcard had just reported it could not open.
const closestMatches = [
  {
    name: "Hot Wheels RC Car, Tesla Cybertruck, 2.4 GHz Remote Controlled 1:64 Scale Vehicle",
    price: "$27.43",
    product_id: "p_d99a84ef04ea",
    url: "https://www.amazon.com/dp/B0GFXZ5NDS",
  },
  {
    name: "Flonk Toys Cybertruck Remote Control Car for Kids, RC Pickup Toy",
    price: "$32.99",
    product_id: "p_557ebad44f9f",
    url: "https://www.amazon.com/dp/B0G2GLWPR9",
  },
];
const unrelatedProduct = {
  name: "LEGO Speed Champions Ken Block's '65 Ford Mustang Hoonicorn V1 77262",
  price: "$23.99",
  product_id: "p_60a7a9aebdc1",
  url: "https://www.amazon.com/dp/B0UNRELATED",
};
const offeredProducts = [...closestMatches, unrelatedProduct];

const noRoadsterStubs = [
  {
    id: "agentcard-no-rc-roadster",
    tool: "agentcard-buy",
    outcome: {
      response: {
        status: "needs_input",
        next_action: null,
        reply:
          "I couldn't find a remote-control Tesla Roadster at Amazon, Walmart, Target or Best Buy. The closest Tesla RC car is the Hot Wheels RC Car, Tesla Cybertruck, $27.43. It's a 2.4 GHz remote-controlled car, but it's a small 1:64 scale Cybertruck, not a Roadster.\n\nThe Flonk Toys Cybertruck Remote Control Car for Kids, $32.99, is another Tesla-style option. It's a bigger RC pickup.\n\nWhich one do you want?",
        cart: null,
        carts: [],
        products: offeredProducts.map(({ name, price, product_id }) => ({
          link_sent: false,
          name,
          price,
          product_id,
          store: "Amazon",
        })),
        approval_expires_at: null,
        link_expires_in: null,
        link_sent: false,
        links_sent: [],
        product_links: offeredProducts.map(({ product_id, url }) => ({
          product_id,
          url,
        })),
      },
    },
  },
] satisfies readonly ToolStub[];

const allowedUrls = new Set(closestMatches.map(({ url }) => url));

// Sanitized from a production run (2026-11-08,
// wrun_41M6WC37QG0GMS3CREND12VX1Z): Agentcard offered a small RC Cybertruck
// and a Matchbox Roadster with no remote. The agent passed on only the
// Cybertruck, judging the Matchbox off-request, and had no page for the
// Cybertruck, which Agentcard named only in its reply. The tool now usually
// recovers that page; both cases are covered here.
const cybertruck = {
  name: "Hot Wheels Toy Car RC, Remote-Control Tesla Cybertruck In 1:64 Scale, Includes Controller & Adapter",
  price: "$29.99",
  product_id: "p_20956e6182af",
  url: "https://www.amazon.com/dp/B0CYBERTRK",
};
const matchbox = {
  name: "Matchbox Tesla Roadster 4/100 (Red)",
  price: "$8.79",
  product_id: "p_c6d812b06d03",
  url: "https://www.amazon.com/dp/B09K4KD1VR",
};
const partialMatches = [cybertruck, matchbox];

// Agentcard's answer with a page only for the `linked` alternatives.
const partialMatchStubs = (linked: readonly (typeof cybertruck)[]) =>
  [
    {
      id: "agentcard-partial-matches",
      tool: "agentcard-buy",
      outcome: {
        response: {
          status: "needs_input",
          next_action: null,
          reply:
            "I didn't find a Tesla Roadster remote-control car at Amazon. Target is still being checked.\n\nThe closest match is the Hot Wheels RC Tesla Cybertruck, $29.99 at Amazon. It's a real Tesla RC with a controller, but it's a 1:64 scale Cybertruck, so it's small and not a Roadster.\n\nThe Matchbox Tesla Roadster, $8.79, is the right car but a die-cast toy with no remote.\n\nWant the Cybertruck, or should I keep looking for a Roadster RC at Walmart, Target or Best Buy?",
          cart: null,
          carts: [],
          products: partialMatches.map(({ name, price, product_id }) => ({
            link_sent: false,
            name,
            price,
            product_id,
            store: "Amazon",
          })),
          approval_expires_at: null,
          link_expires_in: null,
          link_sent: false,
          links_sent: [],
          product_links: linked.map(({ product_id, url }) => ({
            product_id,
            url,
          })),
        },
      },
    },
  ] satisfies readonly ToolStub[];

// The closest match is linked alone when it has a page, and the other
// alternatives are linked when it has none; the text lists both either way.
const partialMatchCases = [
  {
    description: "Lists every alternative but links only the closest match when it has a page",
    expectedLinks: [cybertruck.url],
    linked: partialMatches,
  },
  {
    description: "Links the other alternatives when the closest match has no page",
    expectedLinks: [matchbox.url],
    linked: [matchbox],
  },
];

// Sanitized from production runs (2026-11-07): no genuine platinum spinner
// anywhere. Agentcard named brass alternatives only in its reply, with no
// structured products, and offered to search jewelers too. The agent first
// dropped the brass and asked about a custom-made platinum spinner; later it
// relayed the jeweler search and kept chasing custom platinum Agentcard said
// it could not buy.
const platinumStubs = [
  {
    id: "agentcard-no-platinum-spinner",
    tool: "agentcard-buy",
    outcome: {
      response: {
        status: "needs_input",
        next_action: null,
        reply:
          'I couldn\'t find a fidget spinner that\'s genuine platinum at Amazon, Walmart, Target, Best Buy or any other store I checked.\n\nEverything that came up is brass, copper, stainless steel or just "metal". For example:\n- Walmart has a brass spinner for $10.99.\n- Amazon has a "Pure Brass" spinner for $19.99.\n- Amazon also has a gold-colored one for $7.99.\n\nI can run another search for solid platinum or platinum-plated at a jeweler or custom maker. Or I can show you a good all-metal spinner, such as a brass one, as a stand-in. Which would you like?',
        cart: null,
        carts: [],
        products: [],
        approval_expires_at: null,
        link_expires_in: null,
        link_sent: false,
        links_sent: [],
      },
    },
  },
] satisfies readonly ToolStub[];

// The agent may send a short progress note before its answer, so check every
// delivered message rather than requiring exactly one.
function deliveredMessages(calls: readonly { input: unknown; name: string; status: string }[]) {
  return calls
    .filter((call) => call.name === "send_message" && call.status === "completed")
    .flatMap((call) => {
      const parsed = sendMessageOutputSchema.safeParse(call.input);
      return parsed.success ? [parsed.data] : [];
    });
}

function deliveredText(messages: ReturnType<typeof deliveredMessages>) {
  return messages
    .flatMap((message) => (message.kind === "message" && message.text ? [message.text] : []))
    .join("\n\n");
}

export default [
  defineEval({
    description:
      "Offers Agentcard's closest match without web search or outside links when the exact product is unavailable",
    tags: [...agentEvalTags, "shopping", "routing"],
    async test(t) {
      const session = await t.session({ stubs: noRoadsterStubs });
      const turn = await session.send(
        "I want to buy a Tesla roadster rc for my kid. Not too expensive. For my 10 year old",
      );
      turn.expectOk();
      turn.succeeded();
      // One search: the store order rides in the ask and Agentcard falls back.
      turn.calledTool("agentcard-buy", { count: 1 });
      turn.notCalledTool("web_search");
      turn.notCalledTool("web_fetch");
      turn.notEvent("child.opened", { data: { name: "browser-agent" } });

      const messages = deliveredMessages(turn.toolCalls);
      const sentUrls = messages.flatMap((message) =>
        message.kind === "link"
          ? [message.url]
          : [
              ...(message.links ?? []),
              ...(message.attachments ?? []).map(({ url }) => url),
              ...(message.text?.match(/https?:\/\/\S+/gu) ?? []),
            ],
      );
      t.check(
        sentUrls,
        satisfies<string[]>(
          (urls) => urls.every((url) => allowedUrls.has(url)),
          "every sent link comes from Agentcard's product_links for a listed match, with no product photos",
        ),
      );

      const text = deliveredText(messages);
      await t.require(
        text,
        satisfies<string>((value) => value.trim().length > 0, "send_message delivered text"),
      );
      t.judge(
        "The response says plainly that no remote-control Tesla Roadster was found, offers the Hot Wheels RC Tesla Cybertruck (and optionally the Flonk Cybertruck) as the closest match with its price, does not mention any LEGO set, and does not offer to search elsewhere or buy through a browser.",
        { on: text },
      )
        .label("closest match without outside links")
        .atLeast(0.8);
      assertPlainTextDelivery(t, text);
    },
  }),
  ...partialMatchCases.map(({ description, expectedLinks, linked }) =>
    defineEval({
      description,
      tags: [...agentEvalTags, "shopping"],
      async test(t) {
        const session = await t.session({ stubs: partialMatchStubs(linked) });
        const turn = await session.send(
          "I want to buy a Tesla roaster rc for my kid. Not too expensive. For my 10 year old",
        );
        turn.expectOk();
        turn.succeeded();
        turn.calledTool("agentcard-buy", { count: 1 });

        const messages = deliveredMessages(turn.toolCalls);
        const sentLinks = messages.flatMap((message) =>
          message.kind === "link" ? [message.url] : (message.links ?? []),
        );
        t.check(
          sentLinks,
          satisfies<string[]>(
            (links) =>
              links.length === expectedLinks.length &&
              expectedLinks.every((url) => links.includes(url)),
            `exactly these store pages are sent as links: ${expectedLinks.join(", ")}`,
          ),
        );

        const text = deliveredText(messages);
        await t.require(
          text,
          satisfies<string>((value) => value.trim().length > 0, "send_message delivered text"),
        );
        t.judge(
          "The response says no remote-control Tesla Roadster was found and offers both alternatives with their prices: the Hot Wheels RC Cybertruck ($29.99), noting it is small or not a Roadster, and the Matchbox Tesla Roadster ($8.79), noting it has no remote.",
          { on: text },
        )
          .label("passes on every alternative")
          .atLeast(0.8);
        assertPlainTextDelivery(t, text);
      },
    }),
  ),
  defineEval({
    description:
      "Passes on the alternatives Agentcard can sell, and stops when the user still wants what it found nowhere",
    tags: [...agentEvalTags, "shopping"],
    async test(t) {
      const session = await t.session({ stubs: platinumStubs });
      const turn = await session.send("i want to buy a real platinium fidget spinner");
      turn.expectOk();
      turn.succeeded();
      turn.calledTool("agentcard-buy", { count: 1 });
      turn.notCalledTool("web_search");
      turn.notCalledTool("web_fetch");

      const text = deliveredText(deliveredMessages(turn.toolCalls));
      await t.require(
        text,
        satisfies<string>((value) => value.trim().length > 0, "send_message delivered text"),
      );
      t.judge(
        "The response says no genuine platinum fidget spinner was found and passes on at least one of the brass alternatives with its store and price (such as Walmart's brass spinner for $10.99). It does not offer to keep searching for platinum, at a jeweler, custom maker, or anywhere else, and does not propose a custom-made platinum spinner.",
        { on: text },
      )
        .label("passes on what Agentcard can sell")
        .atLeast(0.8);
      assertPlainTextDelivery(t, text);

      const insist = await session.send("I want a real platinum one");
      insist.expectOk();
      insist.succeeded();
      insist.notCalledTool("agentcard-buy");
      insist.notCalledTool("web_search");
      insist.notCalledTool("web_fetch");
      const insistText = deliveredText(deliveredMessages(insist.toolCalls));
      t.judge(
        "The response says plainly that a real platinum fidget spinner can't be bought here, and at most offers the brass alternatives again. It does not offer to keep looking, suggest a jeweler or custom maker, or ask about budget or other details for a platinum spinner.",
        { on: insistText },
      )
        .label("stops when the user insists")
        .atLeast(0.8);
    },
  }),
];
