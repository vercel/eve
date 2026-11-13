"use client";

import { type SubmitEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";
import { DialogFooter } from "@web/components/ui/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@web/components/ui/field";
import { Input } from "@web/components/ui/input";
import {
  paymentCardBrand,
  paymentCardType,
  serializePaymentCard,
} from "@shared/vault/schema";
import { api } from "@web/trpc/client";

const paymentCardFormSchema = z.object({
  billingPostalCode: z.string().trim().min(1, "Enter the billing postal code."),
  cardNumber: z
    .string()
    .transform((value) => value.replaceAll(/\D/gu, ""))
    .pipe(z.string().regex(/^\d{12,19}$/u, "Enter a valid card number."))
    .refine(passesLuhnCheck, "Check the card number."),
  cardholderName: z.string().trim().min(1, "Enter the name on the card."),
  cvc: z
    .string()
    .transform((value) => value.replaceAll(/\D/gu, ""))
    .pipe(z.string().regex(/^\d{3,4}$/u, "Enter a valid CVC.")),
  expiration: z
    .string()
    .regex(/^(0[1-9]|1[0-2]) \/ \d{2}$/u, "Use MM / YY.")
    .refine(isCurrentExpiration, "Use a current expiration date."),
  nickname: z.string().trim().max(120),
});

export function CardForm({
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
    billingPostalCode: "",
    cardNumber: "",
    cardholderName: "",
    cvc: "",
    expiration: "",
    nickname: initialLabel,
  });
  const cardType = paymentCardType(form.cardNumber);
  const result = paymentCardFormSchema.safeParse(form);
  const errors =
    attempted && !result.success
      ? z.flattenError(result.error).fieldErrors
      : {};

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAttempted(true);
    if (!result.success) return;

    const [month, shortYear] = result.data.expiration.split(" / ");
    if (month === undefined || shortYear === undefined) return;

    const brand = paymentCardBrand(result.data.cardNumber);
    const lastFour = result.data.cardNumber.slice(-4);
    create.mutate({
      account: `${brand} · •••• ${lastFour}`,
      kind: "payment",
      label: result.data.nickname || `${brand} ${lastFour}`,
      secret: serializePaymentCard({
        billingPostalCode: result.data.billingPostalCode,
        cardholderName: result.data.cardholderName,
        expirationMonth: Number(month),
        expirationYear: 2000 + Number(shortYear),
        kind: "payment-card",
        number: result.data.cardNumber,
        securityCode: result.data.cvc,
        version: 1,
      }),
    });
  };

  return (
    <form noValidate onSubmit={submit}>
      <FieldGroup>
        <div className="grid gap-3 sm:grid-cols-2">
          <CardField
            autoComplete="cc-name"
            error={errors.cardholderName?.[0]}
            id="vault-payment-cardholder"
            label="Name on card"
            name="cc-name"
            onChange={(cardholderName) => {
              setForm((current) => ({ ...current, cardholderName }));
            }}
            value={form.cardholderName}
          />
          <CardField
            autoComplete="off"
            error={errors.nickname?.[0]}
            id="vault-payment-nickname"
            label="Nickname (optional)"
            name="card-nickname"
            onChange={(nickname) => {
              setForm((current) => ({ ...current, nickname }));
            }}
            placeholder="Personal"
            value={form.nickname}
          />
        </div>

        <CardField
          autoComplete="cc-number"
          error={errors.cardNumber?.[0]}
          id="vault-payment-number"
          inputMode="numeric"
          label="Card number"
          maxLength={23}
          name="cc-number"
          onChange={(value) => {
            setForm((current) => ({
              ...current,
              cardNumber: formatCardNumber(value),
            }));
          }}
          placeholder="1234 5678 9012 3456"
          trailingLabel={cardType?.niceType}
          value={form.cardNumber}
        />

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1fr_1fr_1.4fr]">
          <CardField
            autoComplete="cc-exp"
            error={errors.expiration?.[0]}
            id="vault-payment-expiration"
            inputMode="numeric"
            label="Expiration"
            maxLength={7}
            name="cc-exp"
            onChange={(value) => {
              setForm((current) => ({
                ...current,
                expiration: formatExpiration(value),
              }));
            }}
            placeholder="MM / YY"
            value={form.expiration}
          />
          <CardField
            autoComplete="cc-csc"
            error={errors.cvc?.[0]}
            id="vault-payment-cvc"
            inputMode="numeric"
            label="CVC"
            maxLength={4}
            name="cc-csc"
            onChange={(value) => {
              setForm((current) => ({
                ...current,
                cvc: value.replaceAll(/\D/gu, "").slice(0, 4),
              }));
            }}
            placeholder="123"
            value={form.cvc}
          />
          <CardField
            autoComplete="postal-code"
            className="col-span-2 sm:col-span-1"
            error={errors.billingPostalCode?.[0]}
            id="vault-payment-postal-code"
            label="Billing ZIP / postal"
            maxLength={20}
            name="postal-code"
            onChange={(billingPostalCode) => {
              setForm((current) => ({ ...current, billingPostalCode }));
            }}
            value={form.billingPostalCode}
          />
        </div>
      </FieldGroup>

      <DialogFooter>
        <Button disabled={create.isPending} type="submit">
          Save card
        </Button>
      </DialogFooter>
    </form>
  );
}

function CardField({
  className,
  error,
  id,
  label,
  onChange,
  trailingLabel,
  ...inputProps
}: Omit<React.ComponentProps<typeof Input>, "onChange"> & {
  readonly error?: string;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly trailingLabel?: string;
}) {
  return (
    <Field className={className} data-invalid={error ? true : undefined}>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {trailingLabel ? (
          <Badge aria-live="polite" variant="outline">
            {trailingLabel}
          </Badge>
        ) : null}
      </div>
      <Input
        {...inputProps}
        aria-invalid={error ? true : undefined}
        id={id}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <FieldError errors={error ? [{ message: error }] : undefined} />
    </Field>
  );
}

function formatCardNumber(value: string) {
  const digits = value.replaceAll(/\D/gu, "").slice(0, 19);
  const gaps = new Set(paymentCardType(digits)?.gaps ?? [4, 8, 12]);

  return digits
    .split("")
    .map((digit, index) => (gaps.has(index) ? ` ${digit}` : digit))
    .join("");
}

function formatExpiration(value: string) {
  const digits = value.replaceAll(/\D/gu, "").slice(0, 4);
  return digits.length <= 2
    ? digits
    : `${digits.slice(0, 2)} / ${digits.slice(2)}`;
}

function passesLuhnCheck(number: string) {
  let sum = 0;
  let doubleDigit = false;

  for (const character of number.split("").toReversed()) {
    let digit = Number(character);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }

  return sum % 10 === 0;
}

function isCurrentExpiration(value: string) {
  const [month, shortYear] = value.split(" / ");
  if (month === undefined || shortYear === undefined) return false;

  const expirationYear = 2000 + Number(shortYear);
  const today = new Date();
  return (
    expirationYear > today.getFullYear() ||
    (expirationYear === today.getFullYear() &&
      Number(month) >= today.getMonth() + 1)
  );
}
