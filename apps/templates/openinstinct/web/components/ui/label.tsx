"use client";
/* oxlint-disable jsx-a11y/label-has-associated-control -- Consumers provide the label-control association at the callsite. */

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@web/components/class-names";

const labelVariants = cva(
  "type-label flex items-center gap-2 select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
  {
    variants: {
      variant: {
        default: null,
        field:
          "group/field-label peer/field-label w-fit group-data-[disabled=true]/field:opacity-50 has-data-checked:border-primary/30 has-data-checked:bg-primary/5 has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col has-[>[data-slot=field]]:rounded-lg has-[>[data-slot=field]]:border *:data-[slot=field]:p-2.5 dark:has-data-checked:border-primary/20 dark:has-data-checked:bg-primary/10",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

function Label({
  className,
  variant,
  ...props
}: React.ComponentProps<"label"> & VariantProps<typeof labelVariants>) {
  return (
    <label
      data-slot="label"
      className={cn(labelVariants({ variant, className }))}
      {...props}
    />
  );
}

export { Label, labelVariants };
