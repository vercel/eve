"use client";

import { PlusIcon } from "lucide-react";
import type { VaultItem } from "@shared/vault/schema";
import { Button } from "@web/components/ui/button";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@web/components/ui/dialog";
import { CardForm } from "./form";
import {
  useVaultSection,
  VaultItemBrowser,
  VaultSection,
  VaultSectionBackButton,
  VaultSectionContent,
  VaultSectionTrigger,
} from "../section";
import { useVaultSetup } from "../setup";

export function VaultCards({
  items,
}: {
  readonly items: readonly VaultItem[];
}) {
  const setup = useVaultSetup();
  const initialAdd = setup?.kind === "payment";
  const section = useVaultSection(initialAdd ? "add" : "list");

  return (
    <VaultSection
      onOpenChange={section.onOpenChange}
      open={section.open}
      title="Cards"
    >
      <VaultSectionTrigger items={items} title="Cards" />
      <VaultSectionContent view={section.view}>
        {section.view === "list" ? (
          <>
            <DialogHeader className="pr-10 sm:pr-6">
              <DialogTitle>Cards</DialogTitle>
              <DialogDescription>
                {items.length > 0
                  ? `Search and manage ${items.length.toLocaleString()} saved cards.`
                  : "Add your first saved card."}
              </DialogDescription>
            </DialogHeader>
            <VaultItemBrowser
              items={items}
              searchId="vault-search-cards"
              title="Cards"
            />
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  section.setView("add");
                }}
                type="button"
              >
                <PlusIcon />
                Add card
              </Button>
            </div>
          </>
        ) : (
          <>
            <VaultSectionBackButton
              onClick={() => {
                section.setView("list");
              }}
              title="Cards"
            />
            <DialogHeader className="pr-10 sm:pr-6">
              <DialogTitle>Add card</DialogTitle>
              <DialogDescription>
                Sensitive values are encrypted before database storage and are
                never returned after saving.
              </DialogDescription>
            </DialogHeader>
            <CardForm
              initialLabel={initialAdd ? setup.label : undefined}
              onSaved={() => {
                section.setView("list");
              }}
            />
          </>
        )}
      </VaultSectionContent>
    </VaultSection>
  );
}
