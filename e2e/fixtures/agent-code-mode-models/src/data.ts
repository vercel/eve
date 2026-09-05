import { createHash } from "node:crypto";

export function dataset(sessionId: string) {
  const seed = Number.parseInt(
    createHash("sha256").update(sessionId).digest("hex").slice(0, 6),
    16,
  );
  const pages = Array.from({ length: 4 }, (_, page) => ({
    cursor: page === 0 ? null : createHash("sha256").update(`${sessionId}:${page}`).digest("hex"),
    orders: [
      { status: "paid", currency: "USD", cents: (seed % 10_000) + 137 * (page + 1) },
      { status: "refunded", currency: "USD", cents: 7_900 },
      { status: "paid", currency: "EUR", cents: 8_300 },
    ],
  }));
  const accounts = ["north", "south", "archive"].map((name, index) => ({
    id: `${name}-${seed.toString(16)}`,
    cents: (seed % 20_000) + 251 * (index + 1),
    available: name !== "archive",
  }));
  return { pages, accounts };
}
