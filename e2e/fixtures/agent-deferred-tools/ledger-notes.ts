/**
 * Deterministic weekly ledger notes, long enough that the first request clears
 * every provider's prompt-cache minimum.
 */
export function ledgerNotes(): string {
  const customers = [
    "Acme",
    "Globex",
    "Initech",
    "Umbrella",
    "Hooli",
    "Vandelay",
    "Stark",
    "Wayne",
  ];
  const lines: string[] = [];
  for (let week = 1; week <= 12; week += 1) {
    lines.push(`Week ${week}`);
    for (const [index, customer] of customers.entries()) {
      const invoice = 2000 + week * 10 + index;
      lines.push(
        `- INV-${invoice}: ${customer} paid ${100 + index * 15} dollars for the team plan; ` +
          `receipt sent, no dispute open, ledger balanced against the processor's settlement report.`,
      );
    }
  }
  return lines.join("\n");
}
