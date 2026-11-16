import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@web/components/class-names";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border bg-clip-padding whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px motion-reduce:transition-none motion-reduce:active:translate-y-0 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        subtle:
          "border-transparent bg-secondary text-muted-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] hover:text-foreground aria-expanded:bg-secondary aria-expanded:text-foreground",
        ghost:
          "border-transparent hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        quiet:
          "border-transparent bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-foreground dark:hover:bg-transparent",
        plain:
          "border-transparent bg-transparent hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent active:not-aria-[haspopup]:translate-y-0",
        surface:
          "border-border bg-card text-card-foreground shadow-sm hover:bg-muted/50 aria-expanded:bg-muted/50 active:not-aria-[haspopup]:translate-y-0",
        destructive:
          "border-destructive-border bg-destructive-subtle text-destructive hover:bg-destructive-subtle/70 focus-visible:border-destructive-border focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        link: "border-transparent text-primary underline-offset-4 hover:underline",
        motion:
          "border-transparent bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground aria-pressed:text-foreground dark:hover:bg-transparent",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 type-label has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 type-caption in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 type-caption in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 type-label has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8 type-label",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] type-label in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] type-label in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9 type-label",
        none: "size-auto rounded-none p-0 type-label",
        surface:
          "h-auto w-full justify-start gap-3 rounded-xl p-4 type-supporting-body text-left whitespace-normal",
        "motion-box": "h-7 gap-1 rounded-md px-0 type-label",
        "motion-line": "h-7 gap-1 rounded-none px-0 pt-0 pb-2 type-label",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>;

function Button({
  className,
  variant = "default",
  size,
  ...props
}: ButtonProps) {
  const resolvedSize = size ?? (variant === "surface" ? "surface" : "default");

  return (
    <ButtonPrimitive
      data-slot="button"
      data-size={resolvedSize}
      data-variant={variant}
      className={cn(buttonVariants({ className, size: resolvedSize, variant }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
export type { ButtonProps };
