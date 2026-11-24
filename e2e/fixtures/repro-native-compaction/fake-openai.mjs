import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 4010);
const PAGES = 16;
const RECIPIENTS = 12;
const LAPSED_AFTER_DAYS = 90;
const PADDING = Number(process.env.FAKE_ITEM_PADDING_CHARS ?? 60_000);

let previousInput = 0;
let requestNumber = 0;
const compactions = new Map();

function unwrap(output) {
  let value = output;
  for (let i = 0; i < 3 && typeof value === "string"; i += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  return value !== null && typeof value === "object" && "value" in value ? value.value : value;
}

function readState(input) {
  const state = { customers: {}, pages: [], records: {}, drafts: [] };
  const calls = new Map();
  for (const item of input) {
    const saved =
      item.type === "compaction"
        ? JSON.parse(Buffer.from(item.encrypted_content.split(".")[0], "base64").toString())
        : item.type === "item_reference"
          ? compactions.get(item.id)
          : undefined;
    if (saved !== undefined) {
      Object.assign(state.customers, saved.customers);
      state.pages.push(...saved.pages);
      Object.assign(state.records, saved.records);
      state.drafts.push(...saved.drafts);
    }
    if (item.type === "function_call") calls.set(item.call_id, item);
    if (item.type === "function_call_output") {
      const call = calls.get(item.call_id);
      if (call === undefined) continue;
      const args = JSON.parse(call.arguments || "{}");
      const result = unwrap(item.output);
      if (call.name === "list_customers" && result?.customers) {
        state.pages.push(args.page);
        for (const c of result.customers) {
          state.customers[c.id] = {
            lifetimeSpend: c.lifetimeSpend,
            lastOrderDaysAgo: c.lastOrderDaysAgo,
          };
        }
      }
      if (call.name === "get_customer" && result?.orders) {
        const quantities = {};
        for (const o of result.orders)
          quantities[o.product] = (quantities[o.product] ?? 0) + o.quantity;
        state.records[args.customerId] = Object.entries(quantities).sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
        )[0][0];
      }
    }
    if (item.type === "function_call" && item.name === "save_draft") {
      state.drafts.push(JSON.parse(item.arguments).customerId);
    }
  }
  return state;
}

function nextAction(state) {
  const pages = new Set(state.pages);
  for (let page = 1; page <= PAGES; page += 1) {
    if (!pages.has(page)) return { name: "list_customers", args: { page } };
  }
  const top = Object.entries(state.customers)
    .filter(([, c]) => c.lastOrderDaysAgo > LAPSED_AFTER_DAYS)
    .sort((a, b) => b[1].lifetimeSpend - a[1].lifetimeSpend)
    .slice(0, RECIPIENTS)
    .map(([id]) => id);
  for (const id of top)
    if (!(id in state.records)) return { name: "get_customer", args: { customerId: id } };
  for (const id of top) {
    if (!state.drafts.includes(id)) {
      return {
        name: "save_draft",
        args: {
          customerId: id,
          subject: "Thank you",
          body: `Thanks for riding with us. Enjoy your ${state.records[id]}.`,
        },
      };
    }
  }
  return undefined;
}

function sse(events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = JSON.parse(raw);
    requestNumber += 1;
    if (process.env.FAKE_DEBUG)
      console.log(
        `  input types: ${body.input.map((i) => i.type ?? i.role).join(",")} bytes=${raw.length}`,
      );
    const inputTokens = Math.ceil(Buffer.byteLength(JSON.stringify(body.input)) / 4) + 3000;
    const cached = previousInput > 0 ? Math.floor(Math.min(previousInput, inputTokens) * 0.98) : 0;
    const usage = {
      input_tokens: inputTokens,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: cached },
    };
    previousInput = inputTokens;
    const state = readState(body.input);
    let output;
    if (body.input.at(-1)?.type === "compaction_trigger") {
      const payload = Buffer.from(JSON.stringify(state)).toString("base64");
      compactions.set(`cmp_${requestNumber}`, state);
      output = [
        {
          type: "compaction",
          id: `cmp_${requestNumber}`,
          encrypted_content: `${payload}.${"x".repeat(PADDING)}`,
        },
      ];
      console.log(`request ${requestNumber}: compaction, state pages=${state.pages.length}`);
    } else {
      const action = nextAction(state);
      if (action === undefined) {
        output = [
          {
            type: "message",
            id: `msg_${requestNumber}`,
            role: "assistant",
            content: [{ type: "output_text", text: "done", annotations: [] }],
          },
        ];
      } else {
        output = [
          {
            type: "function_call",
            id: `fc_${requestNumber}`,
            call_id: `call_${requestNumber}`,
            name: action.name,
            arguments: JSON.stringify(action.args),
            status: "completed",
          },
        ];
      }
      console.log(
        `request ${requestNumber}: input~${inputTokens} cached=${cached} -> ${action ? action.name : "done"}`,
      );
    }
    const events = [
      {
        type: "response.created",
        response: { id: `resp_${requestNumber}`, created_at: 1, model: "gpt-6.1-sol" },
      },
    ];
    output.forEach((item, index) => {
      if (item.type === "message") {
        events.push(
          {
            type: "response.output_item.added",
            output_index: index,
            item: { ...item, content: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: index,
            delta: "done",
          },
        );
      }
      if (item.type === "function_call") {
        events.push(
          {
            type: "response.output_item.added",
            output_index: index,
            item: { ...item, arguments: "" },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            output_index: index,
            delta: item.arguments,
          },
        );
      }
      events.push({ type: "response.output_item.done", output_index: index, item });
    });
    events.push({ type: "response.completed", response: { usage } });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse(events));
  });
});

server.listen(PORT, () => console.log(`fake OpenAI Responses server on ${PORT}`));
