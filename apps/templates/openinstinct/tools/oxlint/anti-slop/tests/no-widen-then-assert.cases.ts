import { typescriptRuleTester as tester } from "./rule-tester.ts";

import { noWidenThenAssertRule } from "@tools/oxlint/anti-slop/rules/no-widen-then-assert.ts";

const error = { messageId: "widenThenAssert" };

tester.run("anti-slop/no-widen-then-assert", noWidenThenAssertRule, {
	valid: [
		"const source = { id: 'first' }; const widened: unknown = source;",
		"declare const input: unknown; const parsed = input as { readonly id: string };",
		"declare const input: any; const widened: unknown = input; const parsed = widened as User;",
		"const widened: object = { id: 'first' }; const parsed = widened as User;",
		"const source = { id: 'first' }; let widened: unknown = source; const parsed = widened as { id: string };",
		"const source = { id: 'first' }; const widened: unknown = source; widened = input; const parsed = widened as { id: string };",
		"const widened: unknown = { id: 'first' }; function parse() { return widened as { id: string }; }",
		"const parsed = widened as { id: string }; const widened: unknown = { id: 'first' };",
		"const widened: object = { id: 'first' }; const parsed = widened as string;",
		"const widened: Record<string, unknown> = { id: 'first' }; const parsed = widened as UserIndex;",
		"const widened: Record<string, unknown> = { id: 'first' }; const parsed = widened as unknown;",
		"const widened: Record<'id', unknown> = { id: 'first' }; const parsed = widened as Record<'id', string>;",
	],
	invalid: [
		{
			code: "const source = { id: 'second' }; const widened: unknown = source; const parsed = widened as { readonly id: string };",
			errors: [error],
		},
		{
			name: "any declaration",
			code: "const source = [1, 2]; const widened: any = source; const parsed = widened as number[];",
			errors: [error],
		},
		{
			name: "object declaration",
			code: "const source = { id: 'second' }; const widened: object = source; const parsed = widened as { readonly id: string };",
			errors: [error],
		},
		{
			name: "broad Record declaration",
			code: "const source = { id: 'second' }; const widened: Record<string, unknown> = source; const parsed = widened as Record<'id', string>;",
			errors: [error],
		},
		{
			name: "readonly broad Record declaration",
			code: "const source = { id: 'second' }; const widened: Readonly<Record<PropertyKey, any>> = source; const parsed = widened as Readonly<Record<'id', string>>;",
			errors: [error],
		},
		{
			name: "broad index signature declaration",
			code: "const source = { id: 'second' }; const widened: { [key: string]: unknown } = source; const parsed = widened as { id: string };",
			errors: [error],
		},
		{
			name: "initializer assertion widens the binding",
			code: "const source = { id: 'second' }; const widened = source as unknown; const parsed = widened as { id: string };",
			errors: [error],
		},
		{
			name: "angle-bracket narrowing assertion",
			code: "const source = { id: 'second' }; const widened: unknown = source; const parsed = <{ id: string }>widened;",
			errors: [error],
		},
		{
			name: "same annotated type restored from object",
			code: "type User = { id: string }; declare function load(): User; const source: User = load(); const widened: object = source; const parsed = widened as User;",
			errors: [error],
		},
		{
			name: "same asserted type restored from object",
			code: "type User = { id: string }; declare const input: unknown; const source = input as User; const widened: object = source; const parsed = widened as User;",
			errors: [error],
		},
		{
			name: "known evidence follows immutable aliases",
			code: "const source = { id: 'second' }; const alias = source; const widened: unknown = alias; const parsed = widened as { id: string };",
			errors: [error],
		},
		{
			name: "same-function boundary",
			code: "function parse() { const source = { id: 'second' }; const widened: unknown = source; return widened as { id: string }; }",
			errors: [error],
		},
	],
});
