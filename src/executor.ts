/**
 * Code executor: Bun.Transpiler + oxc-parser REPL transform + vm.runInThisContext.
 *
 * Pipeline:
 * 1. Bun.Transpiler strips TypeScript types → JS
 * 2. oxc-parser parses JS → ESTree AST with source positions
 * 3. AST transform: let/const→var (hoist+assign), import→await import(), class→var+expression
 * 4. vm.runInThisContext in global scope — var persists + re-declares + timeout safety net
 */

import process from 'node:process';
import vm from 'node:vm';
import { parseSync } from 'oxc-parser';

/** Execute code in global scope with import() support.
 *
 * breakOnSigint is a no-op in current Bun but will enable reactive sync interrupt when implemented.
 */
function runCode(code: string): unknown {
	return vm.runInThisContext(code, {
		breakOnSigint: true,
		importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
	}) as unknown;
}

declare global {
	var $result: unknown;
}

export type StreamOutput = {
	stream: 'stdout' | 'stderr';
	text: string;
};

export type DisplayData = {
	data: Record<string, string>;
	metadata: Record<string, string>;
	transient: { display_id?: string };
	update?: boolean;
};

export type ExecuteOptions = {
	inputRequest?: (prompt: string, password?: boolean) => Promise<string | undefined>;
	publishDisplay?: (data: DisplayData) => Promise<void>;
};

export type ExecutionResult = {
	displayData: Array<DisplayData>;
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

const JUPYTER_DISPLAY = Symbol.for('Jupyter.display');

/** Build a MIME bundle from a value: checks for [Symbol.for("Jupyter.display")] method. */
export function mimeBundle(value: unknown): Record<string, string> {
	if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
		const fn = (value as Record<symbol, unknown>)[JUPYTER_DISPLAY];
		if (typeof fn === 'function') {
			const bundle = (fn as () => unknown).call(value);
			if (bundle && typeof bundle === 'object') return bundle as Record<string, string>;
		}
	}
	return { 'text/plain': formatValue(value) };
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
	// Pre-process: wrap last expression in $result = (...) to prevent
	// Bun.Transpiler from tree-shaking trailing expression statements.
	let modifiedSource = source;
	const tsParsed = parseSync('cell.ts', source, { sourceType: 'module' });
	if (!tsParsed.errors || tsParsed.errors.length === 0) {
		const tsBody = tsParsed.program.body as Array<AnyNode>;
		if (tsBody.length > 0) {
			const lastStmt = tsBody.at(-1);
			if (lastStmt?.type === 'ExpressionStatement' && lastStmt.expression) {
				const expr = lastStmt.expression as AnyNode;
				modifiedSource = `${source.slice(0, expr.start)}$result = (${source.slice(
					expr.start,
					expr.end,
				)})${source.slice(expr.end)}`;
			}
		}
	}

	const jsCode = transpiler.transformSync(modifiedSource);
	const { program, errors } = parseSync('cell.js', jsCode, { sourceType: 'module' });
	if (errors && errors.length > 0) throw new Error(errors[0]?.message);

	const hoisted: Array<string> = [];
	const bodyParts: Array<string> = [];
	let needsAsync = false;
	const body = program.body as Array<AnyNode>;

	for (const node of body) {
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
		else bodyParts.push(jsCode.slice(node.start, node.end));
	}

	const hoistedCode = hoisted.join(' ');
	const bodyStr = bodyParts.join(' ');

	if (needsAsync) return `var $result; ${hoistedCode} (async () => { ${bodyStr} })()`;
	return `var $result; ${hoistedCode} ${bodyStr}`;
}

function cleanStack(stack: string): Array<string> {
	return stack
		.split('\n')
		.filter((line) => !line.includes('executor.ts') && !line.includes('node:vm'))
		.map((line) => line.trim())
		.filter(Boolean);
}

export class Executor {
	private readonly transpiler = new Bun.Transpiler({ loader: 'ts' });
	private executing = false;
	private rejectInterrupt: ((err: Error) => void) | undefined;

	async execute(code: string, options?: ExecuteOptions): Promise<ExecutionResult> {
		if (this.executing) throw new Error('execution already in progress');
		this.executing = true;

		const outputs: Array<StreamOutput> = [];
		const displayData: Array<DisplayData> = [];
		const pendingDisplays: Array<Promise<void>> = [];

		const con = globalThis.console;
		const origLog = con.log;
		const origError = con.error;
		const origWarn = con.warn;
		const origInfo = con.info;

		type WritableLike = { write: (chunk: unknown) => boolean };
		const stdout = process.stdout as WritableLike;
		const stderr = process.stderr as WritableLike;
		const origStdoutWrite = stdout.write;
		const origStderrWrite = stderr.write;

		const capture =
			(stream: 'stdout' | 'stderr') =>
			(...args: Array<unknown>) => {
				outputs.push({ stream, text: `${args.map(formatValue).join(' ')}\n` });
			};

		con.log = capture('stdout');
		con.error = capture('stderr');
		con.warn = capture('stderr');
		con.info = capture('stdout');

		stdout.write = (chunk: unknown) => {
			outputs.push({ stream: 'stdout', text: String(chunk) });
			return true;
		};
		stderr.write = (chunk: unknown) => {
			outputs.push({ stream: 'stderr', text: String(chunk) });
			return true;
		};

		const g = globalThis as Record<string, unknown>;
		const origDisplay = g.display;
		const origPrompt = g.prompt;
		const origConfirm = g.confirm;

		g.display = async (
			data: Record<string, string>,
			opts: { display_id?: string; update?: boolean } = {},
		) => {
			const dd: DisplayData = {
				data,
				metadata: {},
				transient: opts.display_id ? { display_id: opts.display_id } : {},
				update: opts.update,
			};
			if (options?.publishDisplay) {
				const p = options.publishDisplay(dd);
				pendingDisplays.push(p);
				await p;
			} else displayData.push(dd);
		};
		if (options?.inputRequest) {
			const req = options.inputRequest;
			g.prompt = (prompt: string) => req(prompt, false);
			g.confirm = async (prompt: string) => {
				const v = await req(prompt, false);
				return v?.toLowerCase() === 'y' || v?.toLowerCase() === 'yes';
			};
		}

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
					displayData,
					error: {
						message: e.message ?? String(error),
						name: e.name ?? 'SyntaxError',
						stack: cleanStack(e.stack ?? ''),
					},
					outputs,
					success: false,
				};
			}
			const result = runCode(transformed);

			if (result instanceof Promise) await Promise.race([result, interruptPromise]);

			let value = globalThis.$result;
			globalThis.$result = undefined;

			await Promise.allSettled(pendingDisplays);
			if (value instanceof Promise) value = await Promise.race([value, interruptPromise]);

			return { displayData, outputs, result: value, success: true };
		} catch (error) {
			const e = error as Error & { message?: string };
			if (e.message === 'Interrupted')
				return {
					displayData,
					error: {
						message: 'Execution interrupted',
						name: 'KeyboardInterrupt',
						stack: [],
					},
					outputs,
					success: false,
				};

			return {
				displayData,
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
			g.display = origDisplay;
			g.prompt = origPrompt;
			g.confirm = origConfirm;
			stdout.write = origStdoutWrite;
			stderr.write = origStderrWrite;
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
			const obj = runCode(`(typeof (${subExpr}) !== 'undefined') ? (${subExpr}) : null`);
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
		const value = runCode(`(typeof (${expr}) !== 'undefined') ? (${expr}) : undefined`);
		if (value !== undefined) return { data: { 'text/plain': Bun.inspect(value) }, found: true };
	} catch {
		// Expression not yet defined
	}
	return { data: {}, found: false };
}
