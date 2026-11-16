"use client";

import type { ComponentProps, ReactNode } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@web/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@web/components/ui/dialog";
import { cn } from "@web/components/class-names";

export function ModelSelector(props: ComponentProps<typeof Dialog>) {
  return <Dialog {...props} />;
}

export function ModelSelectorTrigger(
  props: ComponentProps<typeof DialogTrigger>
) {
  return <DialogTrigger {...props} />;
}

export function ModelSelectorContent({
  children,
  className,
  title = "Choose a model",
  ...props
}: ComponentProps<typeof DialogContent> & { readonly title?: ReactNode }) {
  return (
    <DialogContent
      aria-describedby={undefined}
      className={cn("border-none p-0 outline outline-border", className)}
      {...props}
    >
      <DialogTitle className="sr-only">{title}</DialogTitle>
      <Command className="**:data-[slot=command-input-wrapper]:h-auto">
        {children}
      </Command>
    </DialogContent>
  );
}

export function ModelSelectorInput({
  className,
  ...props
}: ComponentProps<typeof CommandInput>) {
  return <CommandInput className={cn("h-auto py-3.5", className)} {...props} />;
}

export function ModelSelectorList(props: ComponentProps<typeof CommandList>) {
  return <CommandList {...props} />;
}

export function ModelSelectorEmpty(props: ComponentProps<typeof CommandEmpty>) {
  return <CommandEmpty {...props} />;
}

export function ModelSelectorGroup(props: ComponentProps<typeof CommandGroup>) {
  return <CommandGroup {...props} />;
}

export function ModelSelectorItem(props: ComponentProps<typeof CommandItem>) {
  return <CommandItem {...props} />;
}

export function ModelSelectorShortcut(
  props: ComponentProps<typeof CommandShortcut>
) {
  return <CommandShortcut {...props} />;
}

export function ModelSelectorLogo({
  className,
  provider,
  ...props
}: Omit<ComponentProps<"img">, "alt" | "src"> & {
  readonly provider: string;
}) {
  return (
    // The official AI Elements selector uses the models.dev provider artwork.
    // oxlint-disable-next-line nextjs/no-img-element -- external provider artwork
    <img
      {...props}
      alt=""
      className={cn("size-4 shrink-0 dark:invert", className)}
      height={16}
      src={`https://models.dev/logos/${provider}.svg`}
      width={16}
    />
  );
}

export function ModelSelectorName({
  className,
  ...props
}: ComponentProps<"span">) {
  return (
    <span
      className={cn("min-w-0 flex-1 truncate text-left", className)}
      {...props}
    />
  );
}
