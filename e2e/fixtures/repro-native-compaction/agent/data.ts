export const CUSTOMER_COUNT = 400;
export const PAGE_SIZE = 25;
export const RECIPIENT_COUNT = 12;
export const LAPSED_AFTER_DAYS = 90;

const PRODUCTS = [
  "Gravel frame",
  "Carbon wheelset",
  "Disc brake set",
  "Chain lube",
  "Tubeless tyre",
  "Saddle",
  "Bar tape",
  "Clipless pedals",
  "Dropper post",
  "Cassette 11-34",
  "Bib shorts",
  "Bike light",
  "Frame bag",
  "Floor pump",
  "Cleat set",
  "Helmet",
];

const FIRST = [
  "Ana",
  "Ben",
  "Chen",
  "Dara",
  "Eli",
  "Fay",
  "Gus",
  "Hana",
  "Ivo",
  "Jun",
  "Kai",
  "Lea",
];
const LAST = ["Alder", "Brook", "Cole", "Dunn", "Ellis", "Frost", "Grant", "Hale", "Ito", "Joyce"];
const NOTE_WORDS = Number(process.env.REPRO_NOTE_WORDS ?? 200);

export interface Order {
  readonly orderId: string;
  readonly product: string;
  readonly quantity: number;
  readonly total: number;
  readonly daysAgo: number;
}

export interface Customer {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly city: string;
  readonly lifetimeSpend: number;
  readonly lastOrderDaysAgo: number;
  readonly notes: string;
  readonly orders: readonly Order[];
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function build(index: number): Customer {
  const next = random(index * 7919 + 17);
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T;
  const orderCount = 6 + Math.floor(next() * 14);
  const orders: Order[] = [];
  let spend = 0;
  let newest = Infinity;
  for (let order = 0; order < orderCount; order += 1) {
    const quantity = 1 + Math.floor(next() * 3);
    const total = Math.round((20 + next() * 480) * quantity);
    const daysAgo = Math.floor(next() * 700);
    spend += total;
    newest = Math.min(newest, daysAgo);
    orders.push({
      orderId: `O-${String(index).padStart(4, "0")}-${order + 1}`,
      product: pick(PRODUCTS),
      quantity,
      total,
      daysAgo,
    });
  }
  const id = `C-${String(index).padStart(4, "0")}`;
  const name = `${pick(FIRST)} ${pick(LAST)}-${index}`;
  const words = Array.from(
    { length: NOTE_WORDS },
    () => pick(PRODUCTS).toLowerCase().split(" ")[0],
  );
  return {
    id,
    name,
    email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@example.com`,
    city: pick(["Lisbon", "Leeds", "Lyon", "Linz", "Lund", "Lodz"]),
    lifetimeSpend: spend,
    lastOrderDaysAgo: newest,
    notes: `Service notes: ${words.join(" ")}.`,
    orders,
  };
}

export const CUSTOMERS: readonly Customer[] = Array.from({ length: CUSTOMER_COUNT }, (_, i) =>
  build(i + 1),
);

export function topProduct(customer: Customer): string {
  const quantities = new Map<string, number>();
  for (const order of customer.orders) {
    quantities.set(order.product, (quantities.get(order.product) ?? 0) + order.quantity);
  }
  return [...quantities.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
}

export const EXPECTED_RECIPIENTS: readonly Customer[] = CUSTOMERS.filter(
  (customer) => customer.lastOrderDaysAgo > LAPSED_AFTER_DAYS,
)
  .sort((a, b) => b.lifetimeSpend - a.lifetimeSpend)
  .slice(0, RECIPIENT_COUNT);

export const TASK = `Our shop has ${CUSTOMER_COUNT} customers. Find the ${RECIPIENT_COUNT} customers with the highest lifetimeSpend among those whose lastOrderDaysAgo is more than ${LAPSED_AFTER_DAYS}. Read every page of the customer list to find them, then read each one's full record to find the product they bought the most units of, and save one thank-you draft for each with save_draft. Each draft's body must name that product. Save exactly ${RECIPIENT_COUNT} drafts and then reply "done".`;
