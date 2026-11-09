// Tally's invoice data layer. Every function is scoped to one organization; callers pass the
// signed-in user's org ID. This in-memory store stands in for Postgres in local development.

export const invoiceStatuses = ["draft", "sent", "overdue", "paid", "void"] as const;
export type InvoiceStatus = (typeof invoiceStatuses)[number];

export interface LineItem {
  description: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Reminder {
  sentAt: string;
  sentBy: string;
  note?: string;
}

export interface Invoice {
  id: string;
  orgId: string;
  number: string;
  clientName: string;
  clientEmail: string;
  status: InvoiceStatus;
  issuedOn: string;
  dueOn: string;
  lineItems: LineItem[];
  reminders: Reminder[];
  voided?: { at: string; by: string; reason: string };
}

export interface InvoiceFilter {
  status?: InvoiceStatus;
  /** Case-insensitive substring of the client's name. */
  client?: string;
}

export interface DraftInvoiceInput {
  clientName: string;
  clientEmail: string;
  dueOn: string;
  lineItems: LineItem[];
}

const store: Invoice[] = [
  invoice("inv_1041", "org_brightside", "INV-1041", "Fernwood Coffee", "ap@fernwood.coffee", {
    status: "overdue",
    issuedOn: "2026-08-03",
    dueOn: "2026-09-02",
    lineItems: [{ description: "Brand refresh, phase 2", quantity: 1, unitPriceCents: 420_000 }],
  }),
  invoice("inv_1042", "org_brightside", "INV-1042", "Atlas Outdoor", "billing@atlasoutdoor.com", {
    status: "sent",
    issuedOn: "2026-10-01",
    dueOn: "2026-10-31",
    lineItems: [
      { description: "Spring catalog design", quantity: 1, unitPriceCents: 950_000 },
      { description: "Product photography (days)", quantity: 3, unitPriceCents: 108_333 },
    ],
  }),
  invoice("inv_1043", "org_brightside", "INV-1043", "Juniper Health", "finance@juniper.health", {
    status: "paid",
    issuedOn: "2026-07-15",
    dueOn: "2026-08-14",
    lineItems: [{ description: "Landing page copy", quantity: 1, unitPriceCents: 98_000 }],
  }),
  invoice("inv_1044", "org_brightside", "INV-1044", "Fernwood Coffee", "ap@fernwood.coffee", {
    status: "draft",
    issuedOn: "2026-10-20",
    dueOn: "2026-11-19",
    lineItems: [{ description: "Menu board illustrations", quantity: 4, unitPriceCents: 40_000 }],
  }),
  invoice("inv_2001", "org_harbor", "INV-2001", "Kestrel Logistics", "ap@kestrel.io", {
    status: "overdue",
    issuedOn: "2026-08-20",
    dueOn: "2026-09-19",
    lineItems: [{ description: "Fleet signage install", quantity: 1, unitPriceCents: 830_000 }],
  }),
  invoice("inv_2002", "org_harbor", "INV-2002", "Mosaic Bakery", "hello@mosaicbakery.com", {
    status: "sent",
    issuedOn: "2026-10-12",
    dueOn: "2026-11-11",
    lineItems: [{ description: "Storefront window decals", quantity: 2, unitPriceCents: 32_000 }],
  }),
];

let nextNumber = 1045;

export function invoiceTotalCents(invoice: Pick<Invoice, "lineItems">): number {
  return invoice.lineItems.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
}

export async function listInvoices(orgId: string, filter: InvoiceFilter = {}): Promise<Invoice[]> {
  const client = filter.client?.toLowerCase();
  return store
    .filter((invoice) => invoice.orgId === orgId)
    .filter((invoice) => filter.status === undefined || invoice.status === filter.status)
    .filter((invoice) => client === undefined || invoice.clientName.toLowerCase().includes(client))
    .map((invoice) => structuredClone(invoice));
}

export async function getInvoice(orgId: string, invoiceId: string): Promise<Invoice | null> {
  const found = find(orgId, invoiceId);
  return found ? structuredClone(found) : null;
}

/** Emails the client a payment reminder for a sent or overdue invoice. */
export async function sendReminder(
  orgId: string,
  invoiceId: string,
  reminder: { sentBy: string; note?: string },
): Promise<Invoice> {
  const invoice = mustFind(orgId, invoiceId);
  if (invoice.status !== "sent" && invoice.status !== "overdue") {
    throw new Error(
      `${invoice.number} is ${invoice.status}; only sent or overdue invoices get reminders.`,
    );
  }
  invoice.reminders.push({ sentAt: new Date().toISOString(), ...reminder });
  return structuredClone(invoice);
}

/** Voids an unpaid invoice. Voiding cannot be undone. */
export async function voidInvoice(
  orgId: string,
  invoiceId: string,
  details: { voidedBy: string; reason: string },
): Promise<Invoice> {
  const invoice = mustFind(orgId, invoiceId);
  if (invoice.status === "paid" || invoice.status === "void") {
    throw new Error(`${invoice.number} is ${invoice.status} and cannot be voided.`);
  }
  invoice.status = "void";
  invoice.voided = { at: new Date().toISOString(), by: details.voidedBy, reason: details.reason };
  return structuredClone(invoice);
}

export async function createDraftInvoice(
  orgId: string,
  input: DraftInvoiceInput,
): Promise<Invoice> {
  const created = invoice(
    `inv_${nextNumber}`,
    orgId,
    `INV-${nextNumber}`,
    input.clientName,
    input.clientEmail,
    {
      status: "draft",
      issuedOn: new Date().toISOString().slice(0, 10),
      dueOn: input.dueOn,
      lineItems: input.lineItems,
    },
  );
  nextNumber += 1;
  store.push(created);
  return structuredClone(created);
}

function find(orgId: string, invoiceId: string): Invoice | undefined {
  return store.find((invoice) => invoice.orgId === orgId && invoice.id === invoiceId);
}

function mustFind(orgId: string, invoiceId: string): Invoice {
  const invoice = find(orgId, invoiceId);
  if (!invoice) throw new Error(`Invoice ${invoiceId} was not found.`);
  return invoice;
}

function invoice(
  id: string,
  orgId: string,
  number: string,
  clientName: string,
  clientEmail: string,
  fields: Pick<Invoice, "status" | "issuedOn" | "dueOn" | "lineItems">,
): Invoice {
  return { id, orgId, number, clientName, clientEmail, ...fields, reminders: [] };
}
