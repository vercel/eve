"use client";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
} from "@ui-sdk/react/command";
import { CheckIcon, CpuIcon, SearchIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { inputVariants } from "@/components/ui/input";
import { modelCatalogSchema, type ModelCatalogItem } from "@/lib/models/catalog";
import { PreferenceRow } from "../../_components/preference-row";
import { updateGatewayModel } from "../actions";

const priceFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  style: "currency",
  currency: "USD",
});

export function ModelSelector({ modelId }: { readonly modelId: string }) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalogItem[]>();
  const [error, setError] = useState<string>();
  const [loading, startLoading] = useTransition();
  const [saving, startSaving] = useTransition();
  const search = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const editorId = useId();
  const groups = useMemo(() => {
    const byProvider = Map.groupBy(catalog ?? [], (model) => model.ownedBy);
    return Array.from(byProvider, ([provider, items]) => ({ provider, items })).sort(
      (left, right) => left.provider.localeCompare(right.provider),
    );
  }, [catalog]);

  useEffect(() => {
    if (open) search.current?.focus();
  }, [open]);

  function loadCatalog() {
    setError(undefined);
    startLoading(async () => {
      try {
        const response = await fetch("/api/models");
        if (!response.ok) throw new Error("Model catalog unavailable");
        setCatalog(modelCatalogSchema.parse(await response.json()));
      } catch {
        setError("Unable to load models. Try again.");
      }
    });
  }

  function close() {
    setOpen(false);
    setError(undefined);
    toggle.current?.focus();
  }

  function select(id: string) {
    if (saving || !catalog?.some((model) => model.id === id)) return;
    if (id === modelId) {
      close();
      return;
    }
    setError(undefined);
    startSaving(async () => {
      try {
        await updateGatewayModel(id);
        close();
      } catch {
        setError("Unable to update the model. Choose a model to try again.");
      }
    });
  }

  return (
    <>
      <PreferenceRow
        icon={CpuIcon}
        title="Active model"
        detail={
          <span aria-live="polite" className="type-mono" title={modelId}>
            {modelId}
          </span>
        }
        action={
          <Button
            aria-controls={open ? editorId : undefined}
            aria-disabled={saving || undefined}
            aria-expanded={open}
            aria-label={open ? "Done choosing model" : "Change model"}
            onClick={() => {
              if (saving) return;
              if (open) close();
              else {
                setOpen(true);
                if (!catalog && !loading) loadCatalog();
              }
            }}
            ref={toggle}
            size="lg"
            type="button"
            variant="ghost"
          >
            {open ? "Done" : "Change"}
          </Button>
        }
      />
      {open && (
        <div className="border-t border-border py-4" id={editorId}>
          <Command filter="contains" onAction={select} className="space-y-3">
            <div className="relative">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground"
              />
              <CommandInput
                aria-label="Search models"
                className={inputVariants({ size: "lg", className: "pl-9" })}
                placeholder="Search by model or provider…"
                ref={search}
              />
            </div>
            {error && (
              <div className="flex flex-wrap items-center gap-2">
                <p className="type-supporting-body text-destructive" role="alert">
                  {error}
                </p>
                {!catalog && (
                  <Button size="sm" type="button" variant="outline" onClick={loadCatalog}>
                    Retry
                  </Button>
                )}
              </div>
            )}
            {(loading || saving) && (
              <p className="type-supporting-body text-muted-foreground" role="status">
                {saving ? "Saving model…" : "Loading models…"}
              </p>
            )}
            {catalog && !loading && (
              <CommandEmpty className="type-supporting-body text-muted-foreground">
                No matching models.
              </CommandEmpty>
            )}
            <CommandList
              aria-label="Available models"
              className="max-h-[min(20rem,50vh)] overflow-y-auto overscroll-contain"
            >
              {groups.map((group) => (
                <CommandGroup key={group.provider}>
                  <CommandGroupLabel className="type-caption px-2.5 py-1.5 text-muted-foreground">
                    {group.provider}
                  </CommandGroupLabel>
                  {group.items.map((model) => (
                    <CommandItem
                      key={model.id}
                      value={model.id}
                      label={model.name}
                      keywords={[model.id, model.ownedBy]}
                      disabled={saving}
                      className="type-supporting-body flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 data-disabled:cursor-default data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                    >
                      <ProviderLogo provider={model.ownedBy} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{model.name}</span>
                        <span className="type-caption block truncate text-muted-foreground">
                          {model.id}
                        </span>
                      </span>
                      <ModelPrice model={model} />
                      {model.id === modelId && (
                        <>
                          <CheckIcon aria-hidden="true" className="size-4 shrink-0" />
                          <span className="sr-only">Current model</span>
                        </>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </div>
      )}
    </>
  );
}

function ProviderLogo({ provider }: { readonly provider: string }) {
  const name = { amazon: "amazon-bedrock", meta: "llama", spacexai: "xai" }[provider] ?? provider;
  return (
    <img
      alt=""
      className="size-4 shrink-0 dark:invert"
      height={16}
      src={`https://models.dev/logos/${encodeURIComponent(name)}.svg`}
      width={16}
    />
  );
}

function ModelPrice({ model }: { readonly model: ModelCatalogItem }) {
  const { input, output } = model.pricing ?? {};
  if (input === undefined || output === undefined) return null;
  return (
    <span className="type-caption max-w-24 shrink-0 text-right text-muted-foreground sm:max-w-none">
      {priceFormatter.format(input)} / {priceFormatter.format(output)} per M
    </span>
  );
}
