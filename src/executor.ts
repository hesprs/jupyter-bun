/**
 * Code executor: Bun.Transpiler + oxc-parser REPL transform + indirect eval.
 *
 * Pipeline:
 * 1. Bun.Transpiler strips TypeScript types → JS
 * 2. oxc-parser parses JS → ESTree AST with source positions
 * 3. AST transform: let/const→var (hoist+assign), import→await import(), class→var+expression
 * 4. Indirect eval (0, eval)() in global scope — var persists + re-declares
 */

import { parseSync } from 'oxc-parser';

const evalCode = (code: string): unknown => (0, eval)(code) as unknown;

declare global {
	// eslint-disable-next-line no-var
	var $result: unknown;
}

export type StreamOutput = {
	stream: 'stdout' | 'stderr';
	text: string;
};

export type ExecutionResult = {
	error?: { message: string; name: string; stack?: Array<string> };
	outputs: Array<StreamOutput>;
	result?: unknown;
	success: boolean;
};

type AnyNode = {
	end: number;
	start: number;
	type: string;
	[key: string]: unknown;
};

function formatValue(v: unknown): string {
	if (v === null) return 'null';
	if (v === undefined) return 'undefined';
	if (typeof v === 'string') return v;
	if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
	return Bun.inspect(v).trim();
}

/** Extract all binding names from a destructuring pattern. */
function extractNames(pattern: unknown): Array<string> {
	if (!pattern || typeof pattern !== 'object') return [];
	const p = pattern as AnyNode;
	switch (p.type) {
		case 'Identifier': {
			return [p.name as string];
		}
		case 'ArrayPattern': {
			return ((p.elements as Array<unknown> | null) ?? []).flatMap((e) => extractNames(e));
		}
		case 'ObjectPattern': {
			return (p.properties as Array<unknown>).flatMap((prop) => {
				const pr = prop as AnyNode;
				if (pr.type === 'Property') return extractNames(pr.value);
				if (pr.type === 'RestElement') return extractNames(pr.argument);
				return [];
			});
		}
		case 'RestElement': {
			return extractNames(p.argument);
		}
		case 'AssignmentPattern': {
			return extractNames(p.left);
		}
		default: {
			return [];
		}
	}
}

/** Walk AST subtree for AwaitExpression or ImportExpression nodes. */
function hasAsyncNode(node: unknown): boolean {
	if (!node || typeof node !== 'object') return false;
	const n = node as AnyNode;
	if (n.type === 'AwaitExpression' || n.type === 'ImportExpression') return true;
	for (const key of Object.keys(n)) {
		if (key === 'type' || key === 'start' || key === 'end') continue;
		const child = n[key];
		if (Array.isArray(child))
			for (const c of child) {
				if (hasAsyncNode(c)) return true;
			}
		else if (
			child &&
			typeof child === 'object' &&
			typeof (child as AnyNode).type === 'string' &&
			hasAsyncNode(child)
		)
			return true;
	}
	return false;
}

function replTransform(transpiler: Bun.Transpiler, source: string): string {
	const jsCode = transpiler.transformSync(source);
	const { program, errors } = parseSync('cell.js', jsCode, { sourceType: 'module' });
	if (errors && errors.length > 0) throw new Error(errors[0]?.message);

	const hoisted: Array<string> = [];
	const bodyParts: Array<string> = [];
	let needsAsync = false;
	const body = program.body as Array<AnyNode>;
	const lastIdx = body.length - 1;

	for (let idx = 0; idx < body.length; idx++) {
		const node = body[idx];
		if (node.type.startsWith('TS')) continue;

		if (hasAsyncNode(node)) needsAsync = true;

		if (node.type === 'ImportDeclaration') {
			needsAsync = true;
			const mod = (node.source as AnyNode).value as string;
			for (const spec of node.specifiers as Array<AnyNode>) {
				const local = (spec.local as AnyNode).name as string;
				hoisted.push(`var ${local};`);
				if (spec.type === 'ImportDefaultSpecifier')
					bodyParts.push(`${local} = (await import(${JSON.stringify(mod)})).default;`);
				else if (spec.type === 'ImportNamespaceSpecifier')
					bodyParts.push(`${local} = await import(${JSON.stringify(mod)});`);
				else {
					const imported = (spec.imported as AnyNode).name as string;
					bodyParts.push(
						`${local} = (await import(${JSON.stringify(mod)})).${imported};`,
					);
				}
			}
		} else if (
			node.type === 'VariableDeclaration' &&
			(node.kind === 'let' || node.kind === 'const')
		)
			for (const decl of node.declarations as Array<AnyNode>) {
				for (const name of extractNames(decl.id)) hoisted.push(`var ${name};`);
				const idStart = (decl.id as AnyNode).start;
				const idEnd = (decl.id as AnyNode).end;
				const idStr = jsCode.slice(idStart, idEnd);
				if (decl.init) {
					const initStart = (decl.init as AnyNode).start;
					const initEnd = (decl.init as AnyNode).end;
					const initText = jsCode.slice(initStart, initEnd);
					if (idStr.startsWith('{') || idStr.startsWith('['))
						bodyParts.push(`(${idStr} = ${initText});`);
					else bodyParts.push(`${idStr} = ${initText};`);
				} else bodyParts.push(`${idStr} = undefined;`);
			}
		else if (node.type === 'ClassDeclaration') {
			const name = (node.id as AnyNode | null)?.name as string | undefined;
			const classText = jsCode.slice(node.start, node.end);
			const classExpr = classText.replace(/^class\s+\w+/u, 'class');
			if (name) hoisted.push(`var ${name};`);
			bodyParts.push(`${name} = ${classExpr};`);
		} else if (node.type === 'FunctionDeclaration')
			hoisted.push(jsCode.slice(node.start, node.end));
		else {
			const text = jsCode.slice(node.start, node.end);
			if (idx === lastIdx && node.type === 'ExpressionStatement')
				bodyParts.push(`$result = ${text}`);
			else bodyParts.push(text);
		}
	}

	const hoistedCode = hoisted.join(' ');
	const bodyStr = bodyParts.join(' ');

	if (needsAsync) return `var $result; ${hoistedCode} (async () => { ${bodyStr} })()`;
	return `var $result; ${hoistedCode} ${bodyStr}`;
}

function cleanStack(stack: string): Array<string> {
	return stack
		.split('\n')
		.filter((line) => !line.includes('executor.ts') && !line.includes('eval'))
		.map((line) => line.trim())
		.filter(Boolean);
}

export class Executor {
	private readonly transpiler = new Bun.Transpiler({ loader: 'ts' });
	private executing = false;
	private rejectInterrupt: ((err: Error) => void) | undefined;

	async execute(code: string): Promise<ExecutionResult> {
		if (this.executing) throw new Error('execution already in progress');
		this.executing = true;

		const outputs: Array<StreamOutput> = [];

		const con = globalThis.console;
		const origLog = con.log;
		const origError = con.error;
		const origWarn = con.warn;
		const origInfo = con.info;

		const capture =
			(stream: 'stdout' | 'stderr') =>
			(...args: Array<unknown>) => {
				outputs.push({ stream, text: `${args.map(formatValue).join(' ')}\n` });
			};

		con.log = capture('stdout');
		con.error = capture('stderr');
		con.warn = capture('stderr');
		con.info = capture('stdout');

		let rejectFn!: (err: Error) => void;
		const interruptPromise = new Promise<never>((_, r) => {
			rejectFn = r;
		});
		this.rejectInterrupt = rejectFn;
		interruptPromise.catch(() => {});

		try {
			let transformed: string;
			try {
				transformed = replTransform(this.transpiler, code);
			} catch (error) {
				const e = error as Error & { message?: string; name?: string };
				return {
					error: {
						message: e.message ?? String(error),
						name: e.name ?? 'SyntaxError',
						stack: cleanStack(e.stack ?? ''),
					},
					outputs,
					success: false,
				};
			}

			const result = evalCode(transformed);

			if (result instanceof Promise) await Promise.race([result, interruptPromise]);

			const value = globalThis.$result;
			if (value !== undefined)
				outputs.push({ stream: 'stdout', text: `${formatValue(value)}\n` });
			globalThis.$result = undefined;

			return { outputs, result: value, success: true };
		} catch (error) {
			const e = error as Error & { message?: string };
			if (e.message === 'Interrupted')
				return {
					error: {
						message: 'Execution interrupted',
						name: 'KeyboardInterrupt',
						stack: [],
					},
					outputs,
					success: false,
				};

			return {
				error: {
					message: e.message ?? String(error),
					name: e.name ?? 'Error',
					stack: cleanStack(e.stack ?? ''),
				},
				outputs,
				success: false,
			};
		} finally {
			con.log = origLog;
			con.error = origError;
			con.warn = origWarn;
			con.info = origInfo;
			this.rejectInterrupt = undefined;
			this.executing = false;
		}
	}

	interrupt(): void {
		this.rejectInterrupt?.(new Error('Interrupted'));
	}
}

export function complete(
	code: string,
	cursorPos: number,
): { cursorStart: number; matches: Array<string> } {
	const sub = code.slice(0, cursorPos);
	const match = /[\w$.]+$/u.exec(sub);
	if (!match) return { cursorStart: cursorPos, matches: [] };
	const expr = match[0];
	const cursorStart = cursorPos - expr.length;

	if (expr.includes('.')) {
		const dotIdx = expr.lastIndexOf('.');
		const subExpr = expr.slice(0, dotIdx);
		const propName = expr.slice(dotIdx + 1);
		try {
			const obj = evalCode(`(typeof (${subExpr}) !== 'undefined') ? (${subExpr}) : null`);
			if (obj !== null && obj !== undefined) {
				const proto = (Object.getPrototypeOf(obj) as object | null) ?? {};
				const props = [
					...Object.getOwnPropertyNames(obj),
					...Object.getOwnPropertyNames(proto),
				];
				const matches = [...new Set(props)]
					.filter((p) => !p.startsWith('Symbol(') && p.startsWith(propName))
					.sort();
				return { cursorStart: cursorPos - propName.length, matches };
			}
		} catch {
			// Expression not yet defined
		}
		return { cursorStart, matches: [] };
	}

	const matches = Object.getOwnPropertyNames(globalThis)
		.filter((p) => !p.startsWith('__') && p.startsWith(expr))
		.sort();
	return { cursorStart, matches };
}

export function inspect(
	code: string,
	cursorPos: number,
): { data: Record<string, string>; found: boolean } {
	const sub = code.slice(0, cursorPos);
	const match = /[\w$.]+$/u.exec(sub);
	if (!match) return { data: {}, found: false };
	const expr = match[0];
	try {
		const value = evalCode(`(typeof (${expr}) !== 'undefined') ? (${expr}) : undefined`);
		if (value !== undefined) return { data: { 'text/plain': Bun.inspect(value) }, found: true };
	} catch {
		// Expression not yet defined
	}
	return { data: {}, found: false };
}
