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

export function FieldError({
  children,
  tone = "error",
}: {
  readonly children: ReactNode;
  readonly tone?: "error" | "warning";
}) {
  return children ? (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`type-supporting-body ${tone === "error" ? "text-destructive" : "text-warning"}`}
    >
      {children}
    </p>
  ) : null;
}
