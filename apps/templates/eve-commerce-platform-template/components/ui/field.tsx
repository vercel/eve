import { Field as FieldPrimitive, FieldLabel as FieldLabelPrimitive } from "@ui-sdk/react/field";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/class-names";

export function Field({ className, ...props }: ComponentProps<typeof FieldPrimitive>) {
  return <FieldPrimitive className={cn("flex w-full flex-col gap-2", className)} {...props} />;
}

export function FieldLabel({ className, ...props }: ComponentProps<typeof FieldLabelPrimitive>) {
  return <FieldLabelPrimitive className={cn("type-label w-fit", className)} {...props} />;
}

export function FieldGroup({ children }: { readonly children: ReactNode }) {
  return <div className="flex w-full flex-col gap-5">{children}</div>;
}

export function FieldError({ children }: { readonly children: ReactNode }) {
  return children ? (
    <p role="alert" className="type-supporting-body text-destructive">
      {children}
    </p>
  ) : null;
}
