import { Skeleton } from "@web/components/ui/skeleton";

export default function Loading() {
  return (
    <div
      aria-label="Loading page"
      className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 sm:px-6 sm:py-8"
    >
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}
