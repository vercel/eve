import Link from "next/link";

import { requireUser } from "../../lib/current-user";
import { getOrganization } from "../../lib/users";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await requireUser();
  const organization = getOrganization(user.orgId);

  return (
    <div className="shell">
      <header className="topbar">
        <strong>Tally</strong>
        <nav>
          <Link href="/invoices">Invoices</Link>
        </nav>
        <span className="spacer" />
        <span className="muted">
          {user.name} · {organization?.name}
        </span>
        <form action="/logout" method="post">
          <button type="submit">Sign out</button>
        </form>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}
