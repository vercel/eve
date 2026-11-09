import { notFound } from "next/navigation";

import { requireUser } from "../../../../lib/current-user";
import { getInvoice, invoiceTotalCents } from "../../../../lib/invoices";
import { formatCents } from "../../../../lib/format";

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const invoice = await getInvoice(user.orgId, id);
  if (!invoice) notFound();

  return (
    <>
      <h1>
        {invoice.number} <span className="status muted">{invoice.status}</span>
      </h1>
      <p>
        {invoice.clientName} · {invoice.clientEmail}
        <br />
        Issued {invoice.issuedOn}, due {invoice.dueOn}
      </p>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
            <th>Unit price</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lineItems.map((item) => (
            <tr key={item.description}>
              <td>{item.description}</td>
              <td>{item.quantity}</td>
              <td>{formatCents(item.unitPriceCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <strong>Total {formatCents(invoiceTotalCents(invoice))}</strong>
      </p>
      <h2>Reminders</h2>
      {invoice.reminders.length === 0 ? (
        <p className="muted">No reminders sent.</p>
      ) : (
        <ul>
          {invoice.reminders.map((reminder) => (
            <li key={reminder.sentAt}>
              {reminder.sentAt} by {reminder.sentBy}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
