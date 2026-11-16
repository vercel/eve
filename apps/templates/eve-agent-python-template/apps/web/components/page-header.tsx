import type { ReactNode } from "react";

/** The title block at the top of the Tasks, Backend, and API pages. */
export function PageHeader({
  title,
  children,
}: {
  title: string;
  /** The description under the title. */
  children: ReactNode;
}) {
  return (
    <header className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="max-w-prose text-sm text-muted-foreground">{children}</p>
    </header>
  );
}
