"use client";

import { SiGithub } from "@icons-pack/react-simple-icons";
import { track } from "@vercel/analytics";
import { Button } from "@vercel/geistdocs/components/button";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { analyticsEvents } from "@/lib/analytics/events";

interface TemplateActionsProps {
  setupPrompt: string;
  sourceHref: string;
  template: string;
}

export const TemplateActions = ({ setupPrompt, sourceHref, template }: TemplateActionsProps) => {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    <div className="flex flex-wrap gap-2">
      <Button
        className="justify-center font-medium text-background-100! text-label-14"
        onClick={copyPrompt}
        type="button"
      >
        <span className="flex items-center gap-2">
          {copied ? (
            <>
              <CheckIcon aria-hidden="true" className="size-4" />
              Paste into your agent.
            </>
          ) : (
            <>
              <CopyIcon aria-hidden="true" className="size-4" />
              Setup with one prompt
            </>
          )}
        </span>
      </Button>
      <Button asChild className="justify-center font-medium text-label-14" variant="outline">
        <a
          href={sourceHref}
          onClick={() => track(analyticsEvents.templateSourceOpened, { template })}
          rel="noopener noreferrer"
          target="_blank"
        >
          <SiGithub aria-hidden="true" className="size-4" />
          View GitHub
        </a>
      </Button>
      <span aria-live="polite" className="sr-only">
        {copied ? "Setup prompt copied to clipboard." : ""}
      </span>
    </div>
  );
};
