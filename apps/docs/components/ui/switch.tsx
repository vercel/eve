"use client";

import { Switch as SwitchPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Toggle switch, ported from the flags-sdk docs homepage. Built on the
 * radix-ui `Switch` primitive with geist gray tokens and a `sm`/`default` size.
 */
function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default";
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs outline-none transition-all focus-visible:border-gray-600 focus-visible:ring-[3px] focus-visible:ring-gray-600/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-gray-1000 data-[state=unchecked]:bg-gray-500 data-[size=default]:h-[1.15rem] data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6 dark:data-[state=unchecked]:bg-gray-alpha-500/80",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-background-100 ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-background-100 dark:data-[state=unchecked]:bg-gray-1000"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
