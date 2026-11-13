import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vitest";
import plugin from "@tools/oxlint/next/index.ts";
import { noRoutePrivateImportsRule } from "@tools/oxlint/next/rules/no-route-private-imports.ts";
import { preferNearestRoutePrivateOwnerRule } from "@tools/oxlint/next/rules/prefer-nearest-route-private-owner.ts";
import { requireGeneratedRoutePropsRule } from "@tools/oxlint/next/rules/require-generated-route-props.ts";
import { requirePageRouteGroupRule } from "@tools/oxlint/next/rules/require-page-route-group.ts";

const tester = new RuleTester();

test("exports the repository-owned Next architecture rules", () => {
  assert.deepEqual(Object.keys(plugin.rules).toSorted(), [
    "no-route-private-imports",
    "prefer-nearest-route-private-owner",
    "require-generated-route-props",
    "require-page-route-group",
  ]);
});

const privateImportRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "local-oxlint-private-")
);
const privateComponent = path.join(
  privateImportRoot,
  "app/account/_components/card.tsx"
);

tester.run("local-next/no-route-private-imports", noRoutePrivateImportsRule, {
  valid: [
    {
      code: 'import "./_components/card";',
      cwd: privateImportRoot,
      filename: path.join(privateImportRoot, "app/account/page.tsx"),
    },
  ],
  invalid: [
    {
      code: 'import "@app/account/_components/card";',
      cwd: privateImportRoot,
      filename: path.join(privateImportRoot, "app/admin/page.tsx"),
      before() {
        fs.mkdirSync(path.dirname(privateComponent), { recursive: true });
        fs.writeFileSync(privateComponent, "export function Card() {}");
      },
      after() {
        fs.rmSync(privateImportRoot, { recursive: true, force: true });
      },
      errors: [{ messageId: "privateImport" }],
    },
  ],
});

const nearestRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "local-oxlint-nearest-")
);
const broadComponent = path.join(nearestRoot, "app/_components/card.tsx");

tester.run(
  "local-next/prefer-nearest-route-private-owner",
  preferNearestRoutePrivateOwnerRule,
  {
    valid: [],
    invalid: [
      {
        code: "export function Card() {}",
        cwd: nearestRoot,
        filename: broadComponent,
        before() {
          fs.mkdirSync(path.dirname(broadComponent), { recursive: true });
          fs.mkdirSync(path.join(nearestRoot, "app/account"), {
            recursive: true,
          });
          fs.writeFileSync(broadComponent, "export function Card() {}");
          fs.writeFileSync(
            path.join(nearestRoot, "app/account/page.tsx"),
            'import { Card } from "../_components/card"; export default Card;'
          );
        },
        after() {
          fs.rmSync(nearestRoot, { recursive: true, force: true });
        },
        errors: [{ messageId: "broadOwner" }],
      },
    ],
  }
);

tester.run(
  "local-next/require-generated-route-props",
  requireGeneratedRoutePropsRule,
  {
    valid: [
      {
        code: 'export default function Page(props: PageProps<"/blog/[slug]">) { return props.params; }',
        filename: "/repo/app/blog/[slug]/page.tsx",
      },
    ],
    invalid: [
      {
        code: "export default function Page(props: { params: Promise<{ slug: string }> }) { return props.params; }",
        filename: "/repo/app/blog/[slug]/page.tsx",
        errors: [{ messageId: "generatedType" }],
      },
    ],
  }
);

const pageGroupRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "local-oxlint-page-group-")
);
const indexPage = path.join(pageGroupRoot, "app/settings/page.tsx");

tester.run("local-next/require-page-route-group", requirePageRouteGroupRule, {
  valid: [],
  invalid: [
    {
      code: "export default function Page() {}",
      cwd: pageGroupRoot,
      filename: indexPage,
      before() {
        fs.mkdirSync(path.join(pageGroupRoot, "app/settings/profile"), {
          recursive: true,
        });
        fs.writeFileSync(indexPage, "export default function Page() {}");
        fs.writeFileSync(
          path.join(pageGroupRoot, "app/settings/profile/page.tsx"),
          "export default function ProfilePage() {}"
        );
      },
      after() {
        fs.rmSync(pageGroupRoot, { recursive: true, force: true });
      },
      errors: [{ messageId: "missingRouteGroup" }],
    },
  ],
});
