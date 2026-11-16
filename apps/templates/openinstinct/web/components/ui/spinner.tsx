import { Loader2Icon } from "lucide-react";

import { cn } from "@web/components/class-names";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      data-slot="spinner"
      aria-hidden="true"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
