import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@web/components/class-names";

const alertVariants = cva(
  "group/alert type-supporting-body relative grid w-full gap-0.5 rounded-lg border px-2.5 py-2 text-left has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        success:
          "border-success-border bg-success-subtle text-success *:data-[slot=alert-description]:text-success *:[svg]:text-current",
        warning:
          "border-warning-border bg-warning-subtle text-warning *:data-[slot=alert-description]:text-warning *:[svg]:text-current",
        information:
          "border-information-border bg-information-subtle text-information *:data-[slot=alert-description]:text-information *:[svg]:text-current",
        destructive:
          "border-destructive-border bg-destructive-subtle text-destructive *:data-[slot=alert-description]:text-destructive *:[svg]:text-current",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

function Alert({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      data-variant={variant}
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "type-label group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "type-supporting-body text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className
      )}
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("absolute top-2 right-2", className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertAction };
