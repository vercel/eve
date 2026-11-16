import { cn } from "@/lib/utils";

/** The app's mark: a sparkle in a rounded square. `app/icon.svg` is the favicon version. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={cn("size-6", className)} viewBox="0 0 24 24">
      <rect className="fill-foreground" height="24" rx="6" width="24" />
      <path
        className="fill-background"
        d="M12 5.5l1.55 4.95L18.5 12l-4.95 1.55L12 18.5l-1.55-4.95L5.5 12l4.95-1.55z"
      />
    </svg>
  );
}
