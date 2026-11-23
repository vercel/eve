"use client";

import { CalendarDaysIcon, ContactRoundIcon, MapPinIcon, type LucideIcon } from "lucide-react";
import { getCountries } from "libphonenumber-js/min";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, inputVariants } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/class-names";
import {
  userProfileSchema,
  type UserProfile,
  type UserProfilePatch,
} from "@/lib/shoppers/profile-schema";
import {
  PreferenceCard,
  PreferenceRow,
  PreferenceRowSkeleton,
} from "../../_components/preference-row";
import { updatePersonalInfo } from "../actions";

type ProfileKey = keyof UserProfile;
type ProfileField = {
  readonly name: ProfileKey;
  readonly label: string;
  readonly autoComplete: string;
  readonly type?: "date" | "email" | "tel";
  readonly wide?: boolean;
};
type ProfileSection = {
  readonly title: string;
  readonly icon: LucideIcon;
  readonly fields: readonly ProfileField[];
  readonly summary: (profile: UserProfile) => string;
};

const countryNames = new Intl.DisplayNames("en", { type: "region" });
const countries = getCountries()
  .map((code) => ({ code, name: countryNames.of(code) ?? code }))
  .sort((left, right) => left.name.localeCompare(right.name, "en"));
const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" });
const sections: readonly ProfileSection[] = [
  {
    title: "Contact details",
    icon: ContactRoundIcon,
    fields: [
      { name: "firstName", label: "First name", autoComplete: "given-name" },
      { name: "lastName", label: "Last name", autoComplete: "family-name" },
      { name: "email", label: "Email", autoComplete: "email", type: "email" },
      { name: "phone", label: "Phone", autoComplete: "tel", type: "tel" },
    ],
    summary: ({ firstName, lastName, email, phone }) =>
      joinDetails([joinDetails([firstName, lastName], " "), email, phone]),
  },
  {
    title: "Shipping address",
    icon: MapPinIcon,
    fields: [
      {
        name: "addressLine1",
        label: "Street address",
        autoComplete: "shipping address-line1",
        wide: true,
      },
      {
        name: "addressLine2",
        label: "Apartment, suite, etc.",
        autoComplete: "shipping address-line2",
        wide: true,
      },
      { name: "city", label: "City", autoComplete: "shipping address-level2" },
      { name: "region", label: "State / region", autoComplete: "shipping address-level1" },
      { name: "postalCode", label: "Postal code", autoComplete: "shipping postal-code" },
      { name: "countryCode", label: "Country", autoComplete: "shipping country" },
    ],
    summary: ({ addressLine1, addressLine2, city, region, postalCode, countryCode }) =>
      joinDetails(
        [
          addressLine1,
          addressLine2,
          city,
          region,
          postalCode,
          countryCode && countryNames.of(countryCode),
        ],
        ", ",
      ),
  },
  {
    title: "Date of birth",
    icon: CalendarDaysIcon,
    fields: [{ name: "dateOfBirth", label: "Date of birth", autoComplete: "bday", type: "date" }],
    summary: ({ dateOfBirth }) => (dateOfBirth ? dateFormat.format(new Date(dateOfBirth)) : ""),
  },
];

export function PersonalInfoForm({ initialProfile }: { readonly initialProfile: UserProfile }) {
  return (
    <PreferenceCard divided>
      {sections.map((section) => (
        <PersonalInfoSection
          key={section.title}
          initialProfile={initialProfile}
          section={section}
        />
      ))}
    </PreferenceCard>
  );
}

export function PersonalInfoSkeleton() {
  return (
    <PreferenceCard divided>
      <span className="sr-only" role="status">
        Loading personal info…
      </span>
      {sections.map(({ title, icon }) => (
        <div className="px-4 sm:px-5" key={title}>
          <PreferenceRowSkeleton title={title} icon={icon} />
        </div>
      ))}
    </PreferenceCard>
  );
}

type SaveStatus = "idle" | "saving" | "saved" | "invalid" | "failed";
type FieldErrors = Partial<Record<ProfileKey, string>>;
const saveDelay = 750;

function PersonalInfoSection({
  initialProfile,
  section,
}: {
  readonly initialProfile: UserProfile;
  readonly section: ProfileSection;
}) {
  const [profile, setProfile] = useState(initialProfile);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [, startSaving] = useTransition();
  const saved = useRef(initialProfile);
  const formRef = useRef<HTMLFormElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const revision = useRef(0);
  const writes = useRef(Promise.resolve());
  const id = useId();
  const summary = section.summary(profile);

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (editing) formRef.current?.querySelector<HTMLElement>("input, select")?.focus();
  }, [editing]);

  function save(form: HTMLFormElement, close = false) {
    clearTimeout(timer.current);
    timer.current = undefined;
    const { values, errors: nextErrors } = readFields(form, section.fields);
    const currentRevision = revision.current;
    setErrors(nextErrors);
    const invalidField = section.fields.find(({ name }) => nextErrors[name]);
    if (invalidField) {
      setStatus("invalid");
      const input = form.elements.namedItem(invalidField.name);
      if (close && input instanceof HTMLElement) input.focus();
      return;
    }

    startSaving(async () => {
      // Compare with the last acknowledged values only after earlier autosaves finish.
      const write = writes.current.then(async () => {
        if (currentRevision !== revision.current) return;
        const patch: UserProfilePatch = {};
        for (const { name } of section.fields) {
          if (values[name] !== saved.current[name]) patch[name] = values[name];
        }
        if (Object.keys(patch).length) {
          setStatus("saving");
          try {
            await updatePersonalInfo(patch);
          } catch {
            if (currentRevision === revision.current) setStatus("failed");
            return;
          }
          saved.current = { ...saved.current, ...patch };
          setProfile(saved.current);
          if (currentRevision === revision.current) setStatus("saved");
        }
        if (close && currentRevision === revision.current) {
          setEditing(false);
          toggle.current?.focus();
        }
      });
      writes.current = write;
      await write;
    });
  }

  function scheduleSave(form: HTMLFormElement) {
    revision.current++;
    clearTimeout(timer.current);
    setStatus("idle");
    timer.current = setTimeout(() => save(form), saveDelay);
  }

  return (
    <section aria-labelledby={`${id}-title`} className="px-4 sm:px-5">
      <PreferenceRow
        icon={section.icon}
        title={section.title}
        titleId={`${id}-title`}
        detail={summary || "Not added"}
        action={
          <Button
            aria-controls={editing ? `${id}-editor` : undefined}
            aria-expanded={editing}
            aria-label={`${editing ? "Done editing" : summary ? "Edit" : "Add"} ${section.title.toLowerCase()}`}
            ref={toggle}
            size="lg"
            type="button"
            variant="ghost"
            onClick={() => {
              if (formRef.current) save(formRef.current, true);
              else {
                setStatus("idle");
                setEditing(true);
              }
            }}
          >
            {editing ? "Done" : summary ? "Edit" : "Add"}
          </Button>
        }
      />
      {editing && (
        <form
          aria-label={`Edit ${section.title.toLowerCase()}`}
          autoComplete="on"
          className="space-y-3 border-t border-border pt-4 pb-3"
          id={`${id}-editor`}
          noValidate
          onBlur={(event) => {
            if (timer.current && !event.currentTarget.contains(event.relatedTarget))
              save(event.currentTarget);
          }}
          onInput={(event) => scheduleSave(event.currentTarget)}
          onSubmit={(event) => {
            event.preventDefault();
            save(event.currentTarget, true);
          }}
          ref={formRef}
        >
          <div
            className={cn("grid gap-4", section.fields.length > 1 ? "sm:grid-cols-2" : "max-w-64")}
          >
            {section.fields.map((field) => (
              <ProfileInput
                key={field.name}
                error={errors[field.name]}
                field={field}
                value={profile[field.name]}
              />
            ))}
          </div>
          <div className="flex min-h-7 flex-wrap items-center gap-2">
            <p
              aria-live="polite"
              className={cn(
                "type-caption",
                status === "failed" || status === "invalid"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {status === "saving"
                ? "Saving…"
                : status === "saved"
                  ? "Saved"
                  : status === "invalid"
                    ? "Check the highlighted fields."
                    : status === "failed"
                      ? "Couldn’t save changes."
                      : "Changes save automatically."}
            </p>
            {status === "failed" && (
              <Button
                size="sm"
                type="button"
                variant="outline"
                onClick={() => {
                  if (formRef.current) save(formRef.current);
                }}
              >
                Retry
              </Button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}

function ProfileInput({
  field,
  value,
  error,
}: {
  readonly field: ProfileField;
  readonly value: string | null;
  readonly error?: string;
}) {
  const id = `personal-info-${field.name}`;
  const props = {
    "aria-describedby": error ? `${id}-error` : undefined,
    "aria-invalid": error ? true : undefined,
    autoComplete: field.autoComplete,
    defaultValue: value ?? "",
    id,
    name: field.name,
  };

  return (
    <div className={cn("min-w-0 space-y-1.5", field.wide && "sm:col-span-2")}>
      <Label htmlFor={id}>{field.label}</Label>
      {field.name === "countryCode" ? (
        <select className={inputVariants({ size: "lg", className: "bg-background" })} {...props}>
          <option value="">Select a country</option>
          {value && !countries.some(({ code }) => code === value) && (
            <option value={value}>{countryNames.of(value)}</option>
          )}
          {countries.map(({ code, name }) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      ) : (
        <Input size="lg" type={field.type} {...props} />
      )}
      {error && (
        <p className="type-caption text-destructive" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

function readFields(form: HTMLFormElement, fields: readonly ProfileField[]) {
  const formData = new FormData(form);
  const values: UserProfilePatch = {};
  const errors: FieldErrors = {};
  for (const { name, label } of fields) {
    const raw = formData.get(name);
    const input = form.elements.namedItem(name);
    const parsed = userProfileSchema.shape[name].safeParse(
      typeof raw === "string" ? raw.trim() || null : null,
    );
    if (!parsed.success || (input instanceof HTMLInputElement && input.validity.badInput)) {
      errors[name] =
        name === "email"
          ? "Enter a valid email address."
          : name === "dateOfBirth"
            ? "Enter a valid date."
            : `Check the ${label.toLowerCase()} field.`;
    } else {
      values[name] = parsed.data;
    }
  }
  return { values, errors };
}

function joinDetails(values: readonly (string | null | undefined)[], separator = " · ") {
  return values.filter(Boolean).join(separator);
}
