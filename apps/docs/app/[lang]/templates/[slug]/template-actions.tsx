"use client";

import { track } from "@vercel/analytics";
import { Button } from "@vercel/geistdocs/components/button";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { analyticsEvents } from "@/lib/analytics/events";

interface TemplateActionsProps {
  demoHref?: string;
  setupPrompt: string;
  sourceHref: string;
  template: string;
}

export const TemplateActions = ({
  demoHref,
  setupPrompt,
  sourceHref,
  template,
}: TemplateActionsProps) => {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const secondaryAction = demoHref
    ? {
        event: analyticsEvents.templateDemoOpened,
        href: demoHref,
        label: "View Demo",
      }
    : {
        event: analyticsEvents.templateSourceOpened,
        href: sourceHref,
        label: "View Source",
      };

  useEffect(
    () => () => {
      if (resetTimer.current) {
        clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  const copyPrompt = async () => {
    await navigator.clipboard.writeText(setupPrompt);
    track(analyticsEvents.templateSetupCopied, { template });
    setCopied(true);
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
    }
    resetTimer.current = setTimeout(() => setCopied(false), 3000);
  };

  return (
    <div className="grid gap-2 sm:flex sm:flex-wrap">
      <Button
        className="w-full justify-center font-medium text-background-100! text-label-14 sm:w-52"
        onClick={copyPrompt}
        type="button"
      >
        <span className="flex items-center gap-2">
          {copied ? (
            <>
              <CheckIcon aria-hidden="true" className="size-4" />
              Paste into your agent
            </>
          ) : (
            <>
              <CopyIcon aria-hidden="true" className="size-4" />
              Setup with one prompt
            </>
          )}
        </span>
      </Button>
      <Button
        asChild
        className="w-full justify-center font-medium text-label-14 sm:w-auto"
        variant="outline"
      >
        <a
          href={secondaryAction.href}
          onClick={() => track(secondaryAction.event, { template })}
          rel="noopener noreferrer"
          target="_blank"
        >
          <ExternalLinkIcon aria-hidden="true" className="size-4" />
          {secondaryAction.label}
        </a>
      </Button>
      <span aria-live="polite" className="sr-only">
        {copied ? "Setup prompt copied to clipboard." : ""}
      </span>
    </div>
  );
};
