import { VaultAddresses } from "./_components/addresses";
import { VaultCards } from "./_components/cards";
import { VaultContacts } from "./_components/contacts";
import { VaultLogins } from "./_components/logins";
import { VaultOtherItems } from "./_components/other";
import { readVaultItems } from "@db/services/vault";
import { requireRequestScope } from "@web/auth/request-scope";

export default async function Page() {
  const scope = await requireRequestScope();
  const items = await readVaultItems(scope);
  const itemsByKind = Object.groupBy(items, (item) => item.kind);
  const otherItems = items.filter(
    (item) =>
      item.kind === "identity" || item.kind === "phone" || item.kind === "token"
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="type-page-title">Vault</h1>
      <VaultLogins items={itemsByKind.login ?? []} />
      <VaultCards items={itemsByKind.payment ?? []} />
      <VaultAddresses items={itemsByKind.address ?? []} />
      <VaultContacts items={itemsByKind.contact ?? []} />
      <VaultOtherItems items={otherItems} />
    </div>
  );
}
