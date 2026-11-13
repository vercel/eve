import { typescriptRuleTester as tester } from "./rule-tester.ts";

import { noForbiddenTermInSymbolNamesRule } from "@tools/oxlint/anti-slop/rules/no-shape-in-symbol-names.ts";

const error = { messageId: "forbiddenSymbolName" };

tester.run("anti-slop/no-shape-in-symbol-names", noForbiddenTermInSymbolNamesRule, {
	valid: [
		"declare const schema: ExternalSchema; const field = schema.shape.id;",
		"declare const outer: External; const value = outer.inner.shape;",
		"declare const schema: ExternalSchema; schema.shape.id.parse('x');",
		"const owner = { id: 1 }; const value = owner.id;",
		"class Owner { #value = 1; read() { return this.#value; } }",
		{ code: "const view = <Panel />;", filename: "component.tsx" },
	],
	invalid: [
		{ code: "const shape = 1;", errors: [error] },
		{ code: "function shapeOf() {}", errors: [error] },
		{ code: "type PayloadShape = { id: string };", errors: [error] },
		{ code: "type Payload = { shape: string };", errors: [error] },
		{
			code: "declare const owner: External; const shape = 'field'; const value = owner[shape];",
			errors: 2,
		},
		{
			name: "private identifier",
			code: "class Owner { #shape = 1; }",
			errors: [error],
		},
		{
			name: "JSX identifier",
			code: "const view = <PayloadShape />;",
			filename: "component.tsx",
			errors: [error],
		},
	],
});
