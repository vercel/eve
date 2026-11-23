import { Label as LabelPrimitive } from "@ui-sdk/react/label";
import type { ComponentProps } from "react";
import { cn } from "@/lib/class-names";

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive>) {
  return (
    <LabelPrimitive
      className={cn("type-label flex items-center gap-2 select-none", className)}
      {...props}
    />
  );
}
