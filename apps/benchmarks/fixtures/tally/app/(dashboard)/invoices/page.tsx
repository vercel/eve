import Link from "next/link";

import { requireUser } from "../../../lib/current-user";
import {
  type InvoiceStatus,
  invoiceStatuses,
  invoiceTotalCents,
  listInvoices,
} from "../../../lib/invoices";
import { formatCents } from "../../../lib/format";

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireUser();
  const { status } = await searchParams;
  const filter = invoiceStatuses.includes(status as InvoiceStatus)
    ? { status: status as InvoiceStatus }
    : {};
  const invoices = await listInvoices(user.orgId, filter);

  return (
    <>
      <h1>Invoices</h1>
      <p>
        <Link href="/invoices">All</Link>
        {invoiceStatuses.map((value) => (
          <span key={value}>
            {" · "}
            <Link className="status" href={`/invoices?status=${value}`}>
              {value}
            </Link>
          </span>
        ))}
      </p>
      <table>
        <thead>
          <tr>
            <th>Number</th>
            <th>Client</th>
            <th>Status</th>
            <th>Due</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => (
            <tr key={invoice.id}>
              <td>
                <Link href={`/invoices/${invoice.id}`}>{invoice.number}</Link>
              </td>
              <td>{invoice.clientName}</td>
              <td className="status">{invoice.status}</td>
              <td>{invoice.dueOn}</td>
              <td>{formatCents(invoiceTotalCents(invoice))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
