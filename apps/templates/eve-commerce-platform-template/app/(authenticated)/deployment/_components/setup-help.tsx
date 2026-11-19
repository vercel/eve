"use client";

import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@ui-sdk/react/popover";
import { CircleHelpIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function SetupHelp({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button aria-label={`Set up ${title}`} size="icon-sm" type="button" variant="ghost" />
        }
      >
        <CircleHelpIcon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-80 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-4 text-popover-foreground shadow-md outline-none"
      >
        <PopoverTitle className="type-label">Set up {title}</PopoverTitle>
        <PopoverDescription className="type-supporting-body mt-2 wrap-anywhere text-muted-foreground [&_a]:underline [&_a]:underline-offset-4 [&_code]:font-mono">
          {children}
        </PopoverDescription>
      </PopoverContent>
    </Popover>
  );
}
