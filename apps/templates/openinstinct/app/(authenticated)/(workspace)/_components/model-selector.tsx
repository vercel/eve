"use client";

import { ChevronsUpDownIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  ModelSelector as ModelSelectorRoot,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorShortcut,
  ModelSelectorTrigger,
} from "@web/components/ai-elements/model-selector";
import { Button } from "@web/components/ui/button";
import { api } from "@web/trpc/client";
import type { RouterOutputs } from "@web/trpc/types";

type ModelCatalogItem = RouterOutputs["models"]["list"][number];

const priceFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
  style: "currency",
  currency: "USD",
});

export function ModelSelector({ modelId }: { readonly modelId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const catalog = api.models.list.useQuery(undefined, {
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });
  const selectModel = api.settings.selectModel.useMutation({
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });
  const groupedModels = useMemo(() => {
    const groups = new Map<string, ModelCatalogItem[]>();
    for (const model of catalog.data ?? []) {
      const providerModels = groups.get(model.ownedBy) ?? [];
      providerModels.push(model);
      groups.set(model.ownedBy, providerModels);
    }
    return [...groups.entries()].toSorted(([left], [right]) =>
      left.localeCompare(right)
    );
  }, [catalog.data]);

  const select = (selectedModelId: string) => {
    selectModel.mutate({ modelId: selectedModelId });
  };

  const catalogError =
    catalog.error instanceof Error
      ? catalog.error.message
      : selectModel.error
        ? "Unable to update the workspace. Try again."
        : undefined;

  return (
    <ModelSelectorRoot onOpenChange={setOpen} open={open}>
      <ModelSelectorTrigger
        render={
          <Button
            disabled={selectModel.isPending}
            size="sm"
            type="button"
            variant="outline"
          />
        }
      >
        <ModelSelectorLogo
          provider={providerLogo(modelId.split("/", 1)[0] ?? modelId)}
        />
        Choose
        <ChevronsUpDownIcon />
      </ModelSelectorTrigger>
      <ModelSelectorContent
        className="sm:max-w-xl"
        showCloseButton={false}
        title="Choose a model"
      >
        <ModelSelectorInput placeholder="Search models…" />
        <ModelSelectorList className="max-h-[min(32rem,70vh)]">
          <ModelSelectorEmpty className="px-3 text-left text-muted-foreground">
            {catalog.isFetching
              ? "Loading models…"
              : (catalogError ?? "No matching models.")}
          </ModelSelectorEmpty>
          {groupedModels.map(([provider, providerModels]) => (
            <ModelSelectorGroup heading={provider} key={provider}>
              {providerModels.map((model) => (
                <ModelSelectorItem
                  data-checked={model.id === modelId}
                  key={model.id}
                  onSelect={() => {
                    select(model.id);
                  }}
                  value={`${model.name} ${model.id} ${model.ownedBy}`}
                >
                  <ModelSelectorLogo provider={providerLogo(model.ownedBy)} />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate">{model.name}</span>
                    <span className="block truncate type-caption text-muted-foreground">
                      {model.id}
                    </span>
                  </span>
                  {formatPricing(model) ? (
                    <ModelSelectorShortcut>
                      {formatPricing(model)}
                    </ModelSelectorShortcut>
                  ) : null}
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelectorRoot>
  );
}

function providerLogo(provider: string) {
  if (provider === "amazon") return "amazon-bedrock";
  if (provider === "meta") return "llama";
  if (provider === "spacexai") return "xai";
  return provider;
}

function formatPricing(model: ModelCatalogItem) {
  if (model.pricing?.input === undefined || model.pricing.output === undefined)
    return undefined;
  return `${priceFormatter.format(model.pricing.input)} / ${priceFormatter.format(model.pricing.output)} per M`;
}
