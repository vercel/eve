"use client";

import { PlusIcon } from "lucide-react";
import type { VaultItem } from "@shared/vault/schema";
import { Button } from "@web/components/ui/button";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@web/components/ui/dialog";
import { AddressForm } from "./form";
import {
  useVaultSection,
  VaultItemBrowser,
  VaultSection,
  VaultSectionBackButton,
  VaultSectionContent,
  VaultSectionTrigger,
} from "../section";
import { useVaultSetup } from "../setup";

export function VaultAddresses({
  items,
}: {
  readonly items: readonly VaultItem[];
}) {
  const setup = useVaultSetup();
  const initialAdd = setup?.kind === "address";
  const section = useVaultSection(initialAdd ? "add" : "list");

  return (
    <VaultSection
      onOpenChange={section.onOpenChange}
      open={section.open}
      title="Addresses"
    >
      <VaultSectionTrigger items={items} title="Addresses" />
      <VaultSectionContent view={section.view}>
        {section.view === "list" ? (
          <>
            <DialogHeader className="pr-10 sm:pr-6">
              <DialogTitle>Addresses</DialogTitle>
              <DialogDescription>
                {items.length > 0
                  ? `Search and manage ${items.length.toLocaleString()} saved addresses.`
                  : "Add your first saved address."}
              </DialogDescription>
            </DialogHeader>
            <VaultItemBrowser
              items={items}
              searchId="vault-search-addresses"
              title="Addresses"
            />
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  section.setView("add");
                }}
                type="button"
              >
                <PlusIcon />
                Add address
              </Button>
            </div>
          </>
        ) : (
          <>
            <VaultSectionBackButton
              onClick={() => {
                section.setView("list");
              }}
              title="Addresses"
            />
            <DialogHeader className="pr-10 sm:pr-6">
              <DialogTitle>Add address</DialogTitle>
              <DialogDescription>
                Sensitive values are encrypted before database storage and are
                never returned after saving.
              </DialogDescription>
            </DialogHeader>
            <AddressForm
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
