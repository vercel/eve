"use client";

import { SiGithub } from "@icons-pack/react-simple-icons";
import { Button } from "@vercel/geistdocs/components/button";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface TemplateActionsProps {
  setupPrompt: string;
  sourceHref: string;
}

export const TemplateActions = ({ setupPrompt, sourceHref }: TemplateActionsProps) => {
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
    setCopied(true);
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
    }
    resetTimer.current = setTimeout(() => setCopied(false), 3000);
  };

  return (
    <div className="grid gap-2 sm:flex sm:flex-wrap">
      <Button
        className="font-medium text-background-100! text-label-14"
        onClick={copyPrompt}
        type="button"
      >
        <span className="grid">
          <span
            aria-hidden="true"
            className="invisible col-start-1 row-start-1 flex items-center gap-2"
          >
            <CheckIcon aria-hidden="true" className="size-4" />
            Copied. Paste in your agent.
          </span>
          <span className="col-start-1 row-start-1 flex items-center justify-self-center gap-2">
            {copied ? (
              <>
                <CheckIcon aria-hidden="true" className="size-4" />
                Copied. Paste in your agent.
              </>
            ) : (
              <>
                <CopyIcon aria-hidden="true" className="size-4" />
                Setup with one prompt
              </>
            )}
          </span>
        </span>
      </Button>
      <Button asChild className="font-medium text-label-14" variant="outline">
        <a href={sourceHref} rel="noopener noreferrer" target="_blank">
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
