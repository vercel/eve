"use client";

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@web/components/class-names";

const separatorVariants = cva(
  "shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
  {
    variants: {
      variant: {
        default: null,
        "button-group":
          "relative self-stretch bg-input data-horizontal:mx-px data-horizontal:w-auto data-vertical:my-px data-vertical:h-auto",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

function Separator({
  className,
  orientation = "horizontal",
  variant,
  ...props
}: SeparatorPrimitive.Props & VariantProps<typeof separatorVariants>) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(separatorVariants({ variant, className }))}
      {...props}
    />
  );
}

export { Separator, separatorVariants };
