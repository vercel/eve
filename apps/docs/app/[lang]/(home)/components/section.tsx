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

/**
 * A desktop window like vercel.com/sandbox's: the material surface, and with a title, traffic
 * lights and the title centered over the content.
 */
export function AppWindow({
  title,
  children,
  className,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn("flex min-w-0 flex-col overflow-hidden material-large", className)}>
      {title ? (
        <header className="relative flex h-9 shrink-0 items-center justify-center shadow-[0_0_0_1px_var(--ds-gray-alpha-200)]">
          <span aria-hidden className="absolute left-3 flex gap-1">
            <span className="size-2 rounded-full bg-[#EE6D5E]" />
            <span className="size-2 rounded-full bg-[#F3BF4A]" />
            <span className="size-2 rounded-full bg-[#5DC753]" />
          </span>
          {/* Kept clear of the traffic lights on both sides, so it stays centered. */}
          <span className="min-w-0 max-w-[calc(100%-7rem)] truncate text-gray-800 text-label-13">
            {title}
          </span>
        </header>
      ) : null}
      {children}
    </div>
  );
}
