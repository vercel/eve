"use client";

import { type SubmitEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Button } from "@web/components/ui/button";
import { DialogFooter } from "@web/components/ui/dialog";
import { FieldGroup } from "@web/components/ui/field";
import { serializeAddressVaultPayload } from "@shared/vault/schema";
import { api } from "@web/trpc/client";
import { FormField } from "../field";

const addressFormSchema = z.object({
  city: z.string().trim().min(1, "Enter the city."),
  countryCode: z.string().trim().length(2, "Use a two-letter country code."),
  line1: z.string().trim().min(1, "Enter the street address."),
  line2: z.string().trim(),
  nickname: z.string().trim().min(1, "Enter a name for this address.").max(120),
  postalCode: z.string().trim().min(1, "Enter the postal code."),
  recipientName: z.string().trim().min(1, "Enter the recipient name."),
  region: z.string().trim().min(1, "Enter the state, province, or region."),
});

export function AddressForm({
  initialLabel = "",
  onSaved,
}: {
  readonly initialLabel?: string;
  readonly onSaved: () => void;
}) {
  const router = useRouter();
  const create = api.vault.create.useMutation({
    onSuccess: () => {
      router.refresh();
      onSaved();
    },
  });
  const [attempted, setAttempted] = useState(false);
  const [form, setForm] = useState({
    city: "",
    countryCode: "US",
    line1: "",
    line2: "",
    nickname: initialLabel,
    postalCode: "",
    recipientName: "",
    region: "",
  });
  const result = addressFormSchema.safeParse(form);
  const errors =
    attempted && !result.success
      ? z.flattenError(result.error).fieldErrors
      : {};

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAttempted(true);
    if (!result.success) return;
    create.mutate({
      account: "",
      kind: "address",
      label: result.data.nickname,
      secret: serializeAddressVaultPayload({
        ...result.data,
        kind: "address",
        version: 1,
      }),
    });
  };

  const update = (field: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  return (
    <form noValidate onSubmit={submit}>
      <FieldGroup>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            error={errors.nickname?.[0]}
            id="vault-address-label"
            label="Name"
            onChange={(value) => {
              update("nickname", value);
            }}
            placeholder="Home"
            value={form.nickname}
          />
          <FormField
            autoComplete="name"
            error={errors.recipientName?.[0]}
            id="vault-address-recipient"
            label="Recipient name"
            onChange={(value) => {
              update("recipientName", value);
            }}
            value={form.recipientName}
          />
        </div>
        <FormField
          autoComplete="address-line1"
          error={errors.line1?.[0]}
          id="vault-address-line1"
          label="Address line 1"
          onChange={(value) => {
            update("line1", value);
          }}
          value={form.line1}
        />
        <FormField
          autoComplete="address-line2"
          error={errors.line2?.[0]}
          id="vault-address-line2"
          label="Address line 2 (optional)"
          onChange={(value) => {
            update("line2", value);
          }}
          value={form.line2}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            autoComplete="address-level2"
            error={errors.city?.[0]}
            id="vault-address-city"
            label="City"
            onChange={(value) => {
              update("city", value);
            }}
            value={form.city}
          />
          <FormField
            autoComplete="address-level1"
            error={errors.region?.[0]}
            id="vault-address-region"
            label="State / province / region"
            onChange={(value) => {
              update("region", value);
            }}
            value={form.region}
          />
        </div>
        <div className="grid grid-cols-[1fr_0.6fr] gap-3">
          <FormField
            autoComplete="postal-code"
            error={errors.postalCode?.[0]}
            id="vault-address-postal"
            label="ZIP / postal code"
            onChange={(value) => {
              update("postalCode", value);
            }}
            value={form.postalCode}
          />
          <FormField
            autoComplete="country"
            error={errors.countryCode?.[0]}
            id="vault-address-country"
            label="Country"
            maxLength={2}
            onChange={(value) => {
              update("countryCode", value.toUpperCase());
            }}
            value={form.countryCode}
          />
        </div>
      </FieldGroup>
      <DialogFooter>
        <Button disabled={create.isPending} type="submit">
          Save address
        </Button>
      </DialogFooter>
    </form>
  );
}
