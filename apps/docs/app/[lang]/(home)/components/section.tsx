import Link from "next/link";
import type { ComponentProps, JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";

// Button's props have no `prefetch`, so the link component sets it.
export const PrefetchLink = (props: ComponentProps<typeof Link>) => (
  <Link {...props} prefetch={true} />
);

export function HomeSection({
  id,
  title,
  lede,
  action,
  children,
  className,
}: {
  id: string;
  title: ReactNode;
  lede?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section aria-labelledby={`${id}-title`} className={cn("py-16 sm:py-24", className)} id={id}>
      {/* An action sits beside the heading on wider screens, and below it when stacked. */}
      <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
        <div className="flex max-w-[44rem] flex-col gap-4">
          <h2
            className="text-balance text-heading-32 text-gray-1000 sm:text-heading-40"
            id={`${id}-title`}
          >
            {title}
          </h2>
          {lede ? <p className="text-pretty text-copy-18 text-gray-900">{lede}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="mt-12 sm:mt-16">{children}</div>
    </section>
  );
}

/** The one bordered surface the homepage uses, reserved for figures. */
export function Frame({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border border-gray-alpha-400 bg-background-100",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function FrameHeader({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-gray-alpha-400 border-b px-4 text-copy-13 text-gray-900">
      {children}
    </div>
  );
}
