/**
 * Integration test: connects to the kernel as a ZMTP client (DEALER + SUB),
 * exercises kernel_info, execute (TS, imports, let re-declaration, await),
 * complete, and is_complete.
 */

import { beforeAll, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import type { Connection } from '@/connection';
import type { JupyterHeader } from '@/protocol';
import { connect } from '@/connection';
import { decodeMsg, makeEncoder, ENC } from '@/protocol';
import { recvMultipart, sendFrames, zmtpHandshake } from '@/zmtp';

const KEY = 'test-key-12345';
const IP = '127.0.0.1';
const BASE_PORT = 5560;

const connInfo = {
	control_port: BASE_PORT + 2,
	hb_port: BASE_PORT,
	iopub_port: BASE_PORT + 4,
	ip: IP,
	key: KEY,
	shell_port: BASE_PORT + 1,
	signature_scheme: 'hmac-sha256',
	stdin_port: BASE_PORT + 3,
	transport: 'tcp',
};

const connFile = '/tmp/bun-jupyter-test-conn.json';
writeFileSync(connFile, JSON.stringify(connInfo));

const SESSION = crypto.randomUUID();
const encode = makeEncoder(SESSION, KEY);
let shell: Connection;
let iopub: Connection;

function makeHeader(msgType: string): JupyterHeader {
	return {
		date: new Date().toISOString(),
		msg_id: crypto.randomUUID(),
		msg_type: msgType,
		session: SESSION,
		username: 'test',
		version: '5.3',
	};
}

function makeFrame(data: Uint8Array, more: boolean, isCommand = false): Uint8Array {
	const flag =
		(more ? 0x01 : 0x00) | (data.length > 255 ? 0x02 : 0x00) | (isCommand ? 0x04 : 0x00);
	if (data.length > 255) {
		const buf = new Uint8Array(9 + data.length);
		buf[0] = flag;
		new DataView(buf.buffer).setUint32(5, data.length);
		buf.set(data, 9);
		return buf;
	}
	const buf = new Uint8Array(2 + data.length);
	buf[0] = flag;
	buf[1] = data.length;
	buf.set(data, 2);
	return buf;
}

type IopubMsg = { content: unknown; msgType: string };

async function drainIopubUntilIdle(): Promise<Array<IopubMsg>> {
	const out: Array<IopubMsg> = [];
	while (true) {
		const frames = await recvMultipart(iopub);
		const msg = decodeMsg(frames);
		out.push({ content: msg.content, msgType: msg.header.msg_type });
		const state = (msg.content as { execution_state?: string }).execution_state;
		if (msg.header.msg_type === 'status' && state === 'idle') return out;
	}
}

async function sendShell(msgType: string, content: unknown): Promise<ReturnType<typeof decodeMsg>> {
	const frames = await encode(msgType, content, makeHeader(msgType));
	await sendFrames(shell, frames);
	const replyFrames = await recvMultipart(shell);
	return decodeMsg(replyFrames);
}

async function executeCell(
	code: string,
	allowStdin = false,
): Promise<{ iopubMsgs: Array<IopubMsg>; ok: boolean; reply: ReturnType<typeof decodeMsg> }> {
	const iopubPromise = drainIopubUntilIdle();
	const reply = await sendShell('execute_request', {
		allow_stdin: allowStdin,
		code,
		silent: false,
		store_history: true,
	});
	const iopubMsgs = await iopubPromise;
	return { iopubMsgs, ok: (reply.content as { status?: string }).status === 'ok', reply };
}

beforeAll(async () => {
	const { default: startKernel } = await import('@/kernel');
	void startKernel(connFile);
	await new Promise((r) => {
		setTimeout(r, 200);
	});

	shell = await connect(IP, BASE_PORT + 1);
	await zmtpHandshake(shell, 'DEALER');

	iopub = await connect(IP, BASE_PORT + 4);
	await zmtpHandshake(iopub, 'SUB');
	const subFrame = makeFrame(ENC.encode(''), false, true);
	await iopub.write(subFrame);
});

test('kernel_info_request', async () => {
	const iopubPromise = drainIopubUntilIdle();
	const reply = await sendShell('kernel_info_request', {});
	await iopubPromise;
	const content = reply.content as { implementation?: string; language_info?: { name?: string } };
	expect(content.implementation).toBe('bun-jupyter-ts-kernel');
	expect(content.language_info?.name).toBe('typescript');
});

test('execute: TypeScript with type annotations', async () => {
	const { ok } = await executeCell("let x: number = 42; console.log('x =', x);");
	expect(ok).toBe(true);
});

test('execute: let re-declaration', async () => {
	const { ok } = await executeCell("let x = 99; console.log('x =', x);");
	expect(ok).toBe(true);
});

test('execute: persisted variable', async () => {
	const { ok } = await executeCell("console.log('x is now', x);");
	expect(ok).toBe(true);
});

test('execute: import statement', async () => {
	const { ok } = await executeCell(
		"import { readFile } from 'node:fs'; console.log('readFile is', typeof readFile);",
	);
	expect(ok).toBe(true);
});

test('execute: imported binding persists', async () => {
	const { ok } = await executeCell("console.log('readFile still:', typeof readFile);");
	expect(ok).toBe(true);
});

test('execute: top-level await', async () => {
	const { ok } = await executeCell(
		"const data = await Promise.resolve({ hello: 'world' }); console.log('data:', data);",
	);
	expect(ok).toBe(true);
});

test('execute: let before await in same cell (needsAsync fix)', async () => {
	const { ok } = await executeCell(
		"let y = 7; await Promise.resolve(88); console.log('y =', y);",
	);
	expect(ok).toBe(true);
});

test('execute: let persists after await cell', async () => {
	const { ok } = await executeCell("console.log('y persisted:', y);");
	expect(ok).toBe(true);
});

test('execute: destructuring', async () => {
	const { ok } = await executeCell(
		"let { p, q } = { p: 1, q: 2 }; console.log('p + q =', p + q);",
	);
	expect(ok).toBe(true);
});

test('execute: function re-declaration', async () => {
	await executeCell('function foo() { return 42 }');
	const { ok } = await executeCell("function foo() { return 99 } console.log('foo():', foo());");
	expect(ok).toBe(true);
});

test('execute: class declaration', async () => {
	const { ok } = await executeCell("class Bar { val = 7 } console.log('Bar:', new Bar().val);");
	expect(ok).toBe(true);
});

test('execute: result value capture (bare expression)', async () => {
	const { ok } = await executeCell('1 + 1');
	expect(ok).toBe(true);
});

test("execute: string with 'await' does not trigger async wrapping", async () => {
	const { ok } = await executeCell("let msg = 'please await me'; msg;");
	expect(ok).toBe(true);
});

test('execute: error handling', async () => {
	const { ok, reply } = await executeCell("throw new Error('intentional error');");
	expect(ok).toBe(false);
	expect((reply.content as { ename?: string }).ename).toBe('Error');
});

test('execute_result: bare expression sends MIME bundle', async () => {
	const { iopubMsgs, ok } = await executeCell('1 + 1');
	expect(ok).toBe(true);
	const result = iopubMsgs.find((m) => m.msgType === 'execute_result');
	expect(result).toBeDefined();
	expect((result?.content as { data?: Record<string, string> })?.data?.['text/plain']).toBe('2');
});

test('display: sends display_data with MIME bundle', async () => {
	const { iopubMsgs, ok } = await executeCell('display({ "text/html": "<b>hi</b>" })');
	expect(ok).toBe(true);
	const dd = iopubMsgs.find((m) => m.msgType === 'display_data');
	expect(dd).toBeDefined();
	expect((dd?.content as { data?: Record<string, string> })?.data?.['text/html']).toBe(
		'<b>hi</b>',
	);
});

test('display: as last expression sends no execute_result', async () => {
	const { iopubMsgs, ok } = await executeCell("display({ 'text/plain': 'x' })");
	expect(ok).toBe(true);
	const result = iopubMsgs.find((m) => m.msgType === 'execute_result');
	expect(result).toBeUndefined();
});

test('display: multiple displays sent immediately during execution', async () => {
	const { iopubMsgs, ok } = await executeCell(
		"display({ 'text/plain': 'first' }); display({ 'text/plain': 'second' }); 42",
	);
	expect(ok).toBe(true);
	const ddMsgs = iopubMsgs.filter((m) => m.msgType === 'display_data');
	expect(ddMsgs.length).toBe(2);
	const result = iopubMsgs.find((m) => m.msgType === 'execute_result');
	expect(result).toBeDefined();
	expect((result?.content as { data?: Record<string, string> })?.data?.['text/plain']).toBe('42');
});

test('prompt: interactive input via stdin', async () => {
	const stdinConn = await connect(IP, BASE_PORT + 3);
	await zmtpHandshake(stdinConn, 'DEALER');

	const iopubPromise = drainIopubUntilIdle();

	const execFrames = await encode(
		'execute_request',
		{
			allow_stdin: true,
			code: 'const name = await prompt("Enter name:"); name;',
			silent: false,
			store_history: true,
		},
		makeHeader('execute_request'),
	);
	await sendFrames(shell, execFrames);

	const stdinFrames = await recvMultipart(stdinConn);
	const stdinMsg = decodeMsg(stdinFrames);
	expect(stdinMsg.header.msg_type).toBe('input_request');

	const replyFrames = await encode('input_reply', { value: 'Alice' });
	await sendFrames(stdinConn, replyFrames);

	const reply = decodeMsg(await recvMultipart(shell));
	expect((reply.content as { status?: string }).status).toBe('ok');

	const iopubMsgs = await iopubPromise;
	const result = iopubMsgs.find((m) => m.msgType === 'execute_result');
	expect(result).toBeDefined();
	expect((result?.content as { data?: Record<string, string> })?.data?.['text/plain']).toBe(
		'Alice',
	);

	stdinConn.close();
});

test('process.stdout.write capture', async () => {
	const { iopubMsgs, ok } = await executeCell("process.stdout.write('raw stdout output')");
	expect(ok).toBe(true);
	const streamMsgs = iopubMsgs.filter((m) => m.msgType === 'stream');
	const stdoutMsgs = streamMsgs.filter((m) => (m.content as { name?: string }).name === 'stdout');
	const text = stdoutMsgs.map((m) => (m.content as { text?: string }).text).join('');
	expect(text).toContain('raw stdout output');
});

test('process.stderr.write capture', async () => {
	const { iopubMsgs, ok } = await executeCell("process.stderr.write('raw stderr output')");
	expect(ok).toBe(true);
	const streamMsgs = iopubMsgs.filter((m) => m.msgType === 'stream');
	const stderrMsgs = streamMsgs.filter((m) => (m.content as { name?: string }).name === 'stderr');
	const text = stderrMsgs.map((m) => (m.content as { text?: string }).text).join('');
	expect(text).toContain('raw stderr output');
});

test('update_display_data: sends update_display_data with display_id', async () => {
	const { iopubMsgs, ok } = await executeCell(
		'display({ "text/html": "<p>v1</p>" }, { display_id: "myid" })',
	);
	expect(ok).toBe(true);
	const dd = iopubMsgs.find((m) => m.msgType === 'display_data');
	expect(dd).toBeDefined();
	expect((dd?.content as { transient?: { display_id?: string } })?.transient?.display_id).toBe(
		'myid',
	);
});

test('update_display_data: update flag sends update_display_data', async () => {
	const { iopubMsgs, ok } = await executeCell(
		'display({ "text/html": "<p>v2</p>" }, { display_id: "myid", update: true })',
	);
	expect(ok).toBe(true);
	const update = iopubMsgs.find((m) => m.msgType === 'update_display_data');
	expect(update).toBeDefined();
	expect(
		(update?.content as { transient?: { display_id?: string } })?.transient?.display_id,
	).toBe('myid');
	expect((update?.content as { data?: Record<string, string> })?.data?.['text/html']).toBe(
		'<p>v2</p>',
	);
});

test('complete_request', async () => {
	const iopubPromise = drainIopubUntilIdle();
	const reply = await sendShell('complete_request', { code: 'console.lo', cursor_pos: 9 });
	await iopubPromise;
	expect((reply.content as { matches?: Array<string> }).matches).toContain('log');
});

test('is_complete_request', async () => {
	const iopubPromise = drainIopubUntilIdle();
	const reply = await sendShell('is_complete_request', { code: 'const x = {' });
	await iopubPromise;
	expect((reply.content as { status?: string }).status).toBe('incomplete');
});
