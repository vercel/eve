"use client";

import { PlusIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import type { VaultItem } from "@shared/vault/schema";
import { Button } from "@web/components/ui/button";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@web/components/ui/dialog";
import { LoginForm } from "./form";
import { ChromeImportPanel } from "./import";
import {
  useVaultSection,
  VaultItemBrowser,
  VaultSection,
  VaultSectionBackButton,
  VaultSectionContent,
  VaultSectionTrigger,
} from "../section";
import { useVaultSetup } from "../setup";

export function VaultLogins({
  items,
}: {
  readonly items: readonly VaultItem[];
}) {
  const searchParams = useSearchParams();
  const setup = useVaultSetup();
  const initialSetup = setup?.kind === "login" ? setup : undefined;
  const initialChromeImport = searchParams.get("import") === "chrome";
  const section = useVaultSection(
    initialChromeImport ? "import" : initialSetup ? "add" : "list"
  );

  return (
    <VaultSection
      onOpenChange={section.onOpenChange}
      open={section.open}
      title="Logins"
    >
      <VaultSectionTrigger items={items} title="Logins" />
      <VaultSectionContent view={section.view}>
        {section.view === "list" ? (
          <>
            <DialogHeader className="pr-10 sm:pr-6">
              <DialogTitle>Logins</DialogTitle>
              <DialogDescription>
                {items.length > 0
                  ? `Search and manage ${items.length.toLocaleString()} saved logins.`
                  : "Add your first saved login."}
              </DialogDescription>
            </DialogHeader>
            <VaultItemBrowser
              items={items}
              searchId="vault-search-logins"
              title="Logins"
            />
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  section.setView("import");
                }}
                type="button"
                variant="outline"
              >
                Bulk import
              </Button>
              <Button
                onClick={() => {
                  section.setView("add");
                }}
                type="button"
              >
                <PlusIcon />
                Add login
              </Button>
            </div>
          </>
        ) : (
          <>
            <VaultSectionBackButton
              onClick={() => {
                section.setView("list");
              }}
              title="Logins"
            />
            {section.view === "import" ? (
              <ChromeImportPanel
                onDone={() => {
                  section.setView("list");
                }}
              />
            ) : (
              <>
                <DialogHeader className="pr-10 sm:pr-6">
                  <DialogTitle>
                    {initialSetup ? `Add ${initialSetup.label}` : "Add login"}
                  </DialogTitle>
                  <DialogDescription>
                    Enter the credentials you use to sign in.
                  </DialogDescription>
                </DialogHeader>
                <LoginForm
                  initialIdentifierType={initialSetup?.identifierType}
                  initialLabel={initialSetup?.label}
                  initialOrigin={initialSetup?.origin}
                  onSaved={() => {
                    section.setView("list");
                  }}
                />
              </>
            )}
          </>
        )}
      </VaultSectionContent>
    </VaultSection>
  );
}
