import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/class-names";

export function PreferenceCard({
  children,
  divided = false,
}: {
  readonly children: ReactNode;
  readonly divided?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card",
        divided ? "divide-y divide-border overflow-hidden" : "px-4 sm:px-5",
      )}
    >
      {children}
    </div>
  );
}

export function PreferenceRow({
  action,
  detail,
  icon: Icon,
  title,
  titleId,
}: {
  readonly action: ReactNode;
  readonly detail: ReactNode;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly titleId?: string;
}) {
  return (
    <div className="flex min-h-20 items-center gap-3 py-3.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <h3 className="type-label" id={titleId}>
          {title}
        </h3>
        <p
          className="type-supporting-body truncate text-muted-foreground"
          title={typeof detail === "string" ? detail : undefined}
        >
          {detail}
        </p>
      </div>
      {action}
    </div>
  );
}

export function PreferenceRowSkeleton({
  icon,
  title,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
}) {
  return (
    <PreferenceRow
      icon={icon}
      title={title}
      detail={
        <span aria-hidden="true" className="flex h-[1lh] items-center">
          <span className="h-2.5 w-24 rounded-md bg-muted motion-safe:animate-pulse" />
        </span>
      }
      action={<Skeleton aria-hidden="true" className="h-8 w-14 shrink-0 rounded-lg" />}
    />
  );
}
