"use client";

import {
  ExternalLinkIcon,
  FileKeyIcon,
  ShieldCheckIcon,
  UploadIcon,
} from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@web/components/ui/alert";
import { Button } from "@web/components/ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@web/components/ui/dialog";
import { Input } from "@web/components/ui/input";
import { Label } from "@web/components/ui/label";
import {
  loginIdentifierSchema,
  serializeLoginVaultPayload,
  type VaultImportItems,
} from "@shared/vault/schema";
import { api } from "@web/trpc/client";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const GOOGLE_PASSWORD_MANAGER_URL = "https://passwords.google.com/options";

export function ChromeImportPanel({ onDone }: { readonly onDone: () => void }) {
  const router = useRouter();
  const importPasswords = api.vault.import.useMutation();
  const [selection, setSelection] =
    useState<ReturnType<typeof parseChromePasswordsCsv>>();
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string>();
  const [importedCount, setImportedCount] = useState<number>();
  const [inputKey, setInputKey] = useState(0);

  const chooseFile = async (file?: File) => {
    importPasswords.reset();
    setError(undefined);
    setImportedCount(undefined);
    setSelection(undefined);
    setFileName(file?.name ?? "");
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      setError("Choose a CSV smaller than 10 MB.");
      return;
    }

    try {
      setSelection(parseChromePasswordsCsv(await file.text()));
    } catch (parseError) {
      setError(
        parseError instanceof Error
          ? parseError.message
          : "That CSV could not be read."
      );
    }
  };

  const importSelectedPasswords = () => {
    if (!selection) return;
    setError(undefined);
    const count = selection.items.length;
    importPasswords.mutate(selection.items, {
      onSuccess: () => {
        router.refresh();
        setSelection(undefined);
        setImportedCount(count);
        setFileName("");
        setInputKey((key) => key + 1);
      },
    });
  };

  const reset = () => {
    importPasswords.reset();
    setSelection(undefined);
    setFileName("");
    setError(undefined);
    setImportedCount(undefined);
    setInputKey((key) => key + 1);
  };
  const importError =
    error ??
    (importPasswords.error
      ? "The import did not finish. Check the vault error and try again."
      : undefined);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Import Chrome passwords</DialogTitle>
        <DialogDescription>
          Export a CSV from Google Password Manager, then choose it here. The
          passwords go into this workspace&apos;s encrypted vault.
        </DialogDescription>
      </DialogHeader>

      {importedCount === undefined ? (
        <div className="grid gap-5">
          <div className="grid gap-2">
            <p className="type-label">1. Export your passwords</p>
            <p className="type-supporting-body text-muted-foreground">
              Open Settings in Google Password Manager and choose Export
              passwords.
            </p>
            <Button
              nativeButton={false}
              render={
                <a
                  aria-label="Open Google Password Manager"
                  href={GOOGLE_PASSWORD_MANAGER_URL}
                  rel="noreferrer"
                  target="_blank"
                />
              }
              variant="outline"
            >
              Open Google Password Manager
              <ExternalLinkIcon />
            </Button>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="chrome-passwords-csv">
              2. Choose the exported CSV
            </Label>
            <Input
              accept=".csv,text/csv"
              disabled={importPasswords.isPending}
              id="chrome-passwords-csv"
              key={inputKey}
              onChange={(event) =>
                void chooseFile(event.currentTarget.files?.[0])
              }
              type="file"
            />
            {selection ? (
              <p className="type-supporting-body text-muted-foreground">
                {selection.items.length.toLocaleString()} login
                {selection.items.length === 1 ? "" : "s"} ready from {fileName}
                {selection.skipped > 0
                  ? ` · ${selection.skipped.toLocaleString()} invalid ${selection.skipped === 1 ? "row" : "rows"} skipped`
                  : ""}
              </p>
            ) : null}
          </div>

          {importError ? (
            <Alert variant="destructive">
              <FileKeyIcon />
              <AlertTitle>Couldn&apos;t import this file</AlertTitle>
              <AlertDescription>{importError}</AlertDescription>
            </Alert>
          ) : null}

          <Alert>
            <ShieldCheckIcon />
            <AlertTitle>Your passwords stay in your vault</AlertTitle>
            <AlertDescription>
              The CSV is read in this browser and is not copied to Kernel.
              Chrome exports passwords as plain text, so delete the file after
              this import.
            </AlertDescription>
          </Alert>
        </div>
      ) : (
        <Alert>
          <ShieldCheckIcon />
          <AlertTitle>
            {importedCount.toLocaleString()} login
            {importedCount === 1 ? "" : "s"} imported
          </AlertTitle>
          <AlertDescription>
            They are now available to the agent through the encrypted vault.
            Delete the exported CSV from your device.
          </AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        {importedCount === undefined ? (
          <Button
            disabled={importPasswords.isPending || !selection}
            onClick={importSelectedPasswords}
            type="button"
          >
            <UploadIcon />
            {importPasswords.isPending
              ? "Importing…"
              : selection
                ? `Import ${selection.items.length.toLocaleString()} ${selection.items.length === 1 ? "login" : "logins"}`
                : "Choose a CSV"}
          </Button>
        ) : (
          <Button
            onClick={() => {
              reset();
              onDone();
            }}
            type="button"
          >
            Done
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function parseChromePasswordsCsv(csv: string) {
  const rows = parseCsv(csv);
  const headers = rows.shift()?.map((header) =>
    header
      .replace(/^\uFEFF/, "")
      .trim()
      .toLowerCase()
  );
  if (!headers) throw new Error("Choose a Chrome passwords CSV file.");

  const indexes = {
    name: headers.indexOf("name"),
    password: headers.indexOf("password"),
    url: headers.indexOf("url"),
    username: headers.indexOf("username"),
  };
  if (indexes.url < 0 || indexes.username < 0 || indexes.password < 0) {
    throw new Error(
      "This CSV needs url, username, and password columns. Export it from Google Password Manager and try again."
    );
  }

  const items: VaultImportItems = [];
  let skipped = 0;

  for (const row of rows) {
    if (row.every((value) => value.length === 0)) continue;

    const account = row[indexes.username]?.trim() ?? "";
    const password = row[indexes.password] ?? "";
    const url = row[indexes.url]?.trim() ?? "";
    const origin = originFromUrl(url);
    const name = indexes.name >= 0 ? row[indexes.name]?.trim() : undefined;
    const label = name?.length ? name : labelFromUrl(url);

    if (
      !label ||
      !origin ||
      account.length === 0 ||
      password.length === 0 ||
      account.length > 300 ||
      label.length > 120 ||
      password.length > 20_000
    ) {
      skipped += 1;
      continue;
    }

    items.push({
      account: "",
      kind: "login",
      label,
      secret: serializeLoginVaultPayload({
        authentication: { password, type: "password" },
        identifier: {
          type: loginIdentifierSchema.safeParse({
            type: "email",
            value: account,
          }).success
            ? "email"
            : "username",
          value: account,
        },
        kind: "login",
        origin,
        version: 2,
      }),
    });
  }

  if (items.length === 0) {
    throw new Error("No valid saved passwords were found in this CSV.");
  }
  if (items.length > 3_000) {
    throw new Error(
      `This file contains ${items.length.toLocaleString()} passwords. Import up to 3,000 at a time.`
    );
  }

  return { items, skipped };
}

function labelFromUrl(value: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./, "") || value;
  } catch {
    return value.slice(0, 120);
  }
}

function originFromUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function parseCsv(csv: string) {
  const rows: string[][] = [];
  let field = "";
  let quoted = false;
  let row: string[] = [];

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv.charAt(index);
    if (quoted) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("This CSV has an unfinished quoted value.");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
