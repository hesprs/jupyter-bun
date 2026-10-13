/**
 * Main Jupyter kernel: channel loops and message dispatch.
 *
 * Ported from Deno's jupyter_kernel.js, adapted for Bun.
 * Runs all five Jupyter channels over ZMTP/TCP.
 */

import { readFileSync } from 'node:fs';
import type { DisplayData, StreamOutput } from '@/executor';
import type { JupyterHeader } from '@/protocol';
import { Executor, complete, inspect, mimeBundle } from '@/executor';
import { decodeMsg, makeEncoder, hmacVerify } from '@/protocol';
import { PubSocket, RouterSocket, startHeartbeat } from '@/sockets';

type ConnectionInfo = {
	control_port: number;
	hb_port: number;
	iopub_port: number;
	ip: string;
	key: string;
	shell_port: number;
	stdin_port: number;
};

type ExecuteRequestContent = {
	allow_stdin?: boolean;
	code?: string;
	silent?: boolean;
	store_history?: boolean;
};

type CompleteRequestContent = {
	code?: string;
	cursor_pos?: number;
};

type InspectRequestContent = {
	code?: string;
	cursor_pos?: number;
};

function checkIsComplete(code: string): { indent: string; status: string } {
	const stack: Array<string> = [];
	let i = 0;
	while (i < code.length) {
		const ch = code[i];
		if (ch === '/' && code[i + 1] === '/') {
			while (i < code.length && code[i] !== '\n') i++;
			continue;
		}
		if (ch === '/' && code[i + 1] === '*') {
			i += 2;
			let closed = false;
			while (i < code.length - 1) {
				if (code[i] === '*' && code[i + 1] === '/') {
					i += 2;
					closed = true;
					break;
				}
				i++;
			}
			if (!closed) return { indent: '', status: 'incomplete' };
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			const q = ch;
			i++;
			let closed = false;
			while (i < code.length) {
				if (code[i] === '\\' && q !== '`') {
					i += 2;
					continue;
				}
				if (code[i] === q) {
					i++;
					closed = true;
					break;
				}
				i++;
			}
			if (!closed) return { indent: '', status: 'incomplete' };
			continue;
		}
		if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
		if (ch === ')' && stack.pop() !== '(') return { indent: '', status: 'invalid' };
		if (ch === ']' && stack.pop() !== '[') return { indent: '', status: 'invalid' };
		if (ch === '}' && stack.pop() !== '{') return { indent: '', status: 'invalid' };

		i++;
	}
	if (stack.length === 0) return { indent: '', status: 'complete' };
	return { indent: '  ', status: 'incomplete' };
}

function kernelInfo() {
	return {
		banner: 'TypeScript (Bun) — pure JS ZMTP, no native deps',
		debugger: false,
		help_links: [{ text: 'Bun docs', url: 'https://bun.sh' }],
		implementation: 'bun-jupyter-ts-kernel',
		implementation_version: '0.1.0',
		language_info: {
			codemirror_mode: 'typescript',
			file_extension: '.ts',
			mimetype: 'text/x.typescript',
			name: 'typescript',
			nbconvert_exporter: 'script',
			pygments_lexer: 'typescript',
			version: '1.0.0',
		},
		protocol_version: '5.3',
		status: 'ok',
	};
}

export default async function startKernel(connectionFile: string): Promise<void> {
	const info = JSON.parse(readFileSync(connectionFile, 'utf8')) as ConnectionInfo;
	const { ip, key, hb_port, shell_port, control_port, stdin_port, iopub_port } = info;
	const session = crypto.randomUUID();
	const executor = new Executor();
	const encode = makeEncoder(session, key);

	startHeartbeat(ip, hb_port);

	const shell = new RouterSocket(ip, shell_port);
	const control = new RouterSocket(ip, control_port);
	const iopub = new PubSocket(ip, iopub_port);
	const stdin = new RouterSocket(ip, stdin_port);

	let executionCount = 0;
	let shuttingDown = false;

	async function publishStatus(status: string, parentHeader: JupyterHeader): Promise<void> {
		await iopub.send(await encode('status', { execution_state: status }, parentHeader));
	}

	async function publishStream(output: StreamOutput, parentHeader: JupyterHeader): Promise<void> {
		await iopub.send(
			await encode('stream', { name: output.stream, text: output.text }, parentHeader),
		);
	}

	async function publishDisplayData(
		data: DisplayData,
		parentHeader: JupyterHeader,
	): Promise<void> {
		const { update, ...displayContent } = data;
		await iopub.send(
			await encode(
				update ? 'update_display_data' : 'display_data',
				displayContent,
				parentHeader,
			),
		);
	}

	async function publishError(
		name: string,
		value: string,
		traceback: Array<string>,
		parentHeader: JupyterHeader,
	): Promise<void> {
		await iopub.send(
			await encode('error', { ename: name, evalue: value, traceback }, parentHeader),
		);
	}

	async function handleExecute(
		peerId: Uint8Array,
		socket: RouterSocket,
		msg: ReturnType<typeof decodeMsg>,
	): Promise<void> {
		const { header: parentHeader, content } = msg;
		const execContent = content as ExecuteRequestContent;
		const silent = execContent.silent ?? false;
		const storeHistory = execContent.store_history !== false;
		const code = execContent.code ?? '';

		if (!silent && storeHistory) executionCount++;

		await publishStatus('busy', parentHeader);
		if (!silent)
			await iopub.send(
				await encode(
					'execute_input',
					{ code, execution_count: executionCount },
					parentHeader,
				),
			);

		const inputRequest =
			execContent.allow_stdin === false
				? undefined
				: async (prompt: string, password = false): Promise<string | undefined> => {
						if (stdin.peerCount === 0)
							await new Promise((r) => {
								setTimeout(r, 100);
							});
						if (stdin.peerCount === 0) return undefined;
						await stdin.sendAll(
							await encode('input_request', { password, prompt }, parentHeader),
						);
						while (true) {
							const { frames: replyFrames } = await stdin.recv();
							try {
								const reply = decodeMsg(replyFrames);
								if (!(await hmacVerify(key, reply.signedParts, reply.sig)))
									continue;
								if (reply.header.msg_type === 'input_reply') {
									const value = (reply.content as { value?: string }).value;
									return typeof value === 'string' ? value : undefined;
								}
							} catch {
								return undefined;
							}
						}
					};

		const result = await executor.execute(code, {
			inputRequest,
			publishDisplay: (data) => publishDisplayData(data, parentHeader),
		});

		if (!silent) {
			for (const output of result.outputs) await publishStream(output, parentHeader);
			if (result.success && result.result !== undefined)
				await iopub.send(
					await encode(
						'execute_result',
						{
							data: mimeBundle(result.result),
							execution_count: executionCount,
							metadata: {},
						},
						parentHeader,
					),
				);
		}

		if (result.success)
			await socket.send(
				peerId,
				await encode(
					'execute_reply',
					{
						execution_count: executionCount,
						payload: [],
						status: 'ok',
						user_expressions: {},
					},
					parentHeader,
				),
			);
		else {
			const err = result.error;
			if (!err) throw new Error('expected error result');
			await publishError(err.name, err.message, err.stack ?? [], parentHeader);
			await socket.send(
				peerId,
				await encode(
					'execute_reply',
					{
						ename: err.name,
						evalue: err.message,
						execution_count: executionCount,
						status: 'error',
						traceback: err.stack ?? [],
					},
					parentHeader,
				),
			);
		}

		await publishStatus('idle', parentHeader);
	}

	async function handleShellMessage(
		socket: RouterSocket,
		peerId: Uint8Array,
		frames: Array<Uint8Array>,
	): Promise<void> {
		const msg = decodeMsg(frames);
		if (!(await hmacVerify(key, msg.signedParts, msg.sig))) return;

		const parentHeader = msg.header;
		const msgType = msg.header.msg_type;

		if (msgType === 'execute_request') {
			await handleExecute(peerId, socket, msg);
			return;
		}

		await publishStatus('busy', parentHeader);
		try {
			if (msgType === 'kernel_info_request')
				await socket.send(
					peerId,
					await encode('kernel_info_reply', kernelInfo(), parentHeader),
				);
			else if (msgType === 'complete_request') {
				const req = msg.content as CompleteRequestContent;
				const code = req.code ?? '';
				const cursorPos = req.cursor_pos ?? code.length;
				const { matches, cursorStart } = complete(code, cursorPos);
				await socket.send(
					peerId,
					await encode(
						'complete_reply',
						{
							cursor_end: cursorPos,
							cursor_start: cursorStart,
							matches,
							metadata: {},
							status: 'ok',
						},
						parentHeader,
					),
				);
			} else if (msgType === 'is_complete_request') {
				const req = msg.content as { code?: string };
				const result = checkIsComplete(req.code ?? '');
				await socket.send(peerId, await encode('is_complete_reply', result, parentHeader));
			} else if (msgType === 'inspect_request') {
				const req = msg.content as InspectRequestContent;
				const code = req.code ?? '';
				const cursorPos = req.cursor_pos ?? code.length;
				const { found, data } = inspect(code, cursorPos);
				await socket.send(
					peerId,
					await encode(
						'inspect_reply',
						{ data, found, metadata: {}, status: 'ok' },
						parentHeader,
					),
				);
			} else if (msgType === 'history_request')
				await socket.send(
					peerId,
					await encode('history_reply', { history: [], status: 'ok' }, parentHeader),
				);
			else if (msgType === 'comm_info_request')
				await socket.send(
					peerId,
					await encode('comm_info_reply', { comms: {}, status: 'ok' }, parentHeader),
				);
			else if (msgType === 'comm_open') {
				const req = msg.content as { comm_id?: string };
				await socket.send(
					peerId,
					await encode('comm_close', { comm_id: req.comm_id, data: {} }, parentHeader),
				);
			}
		} finally {
			await publishStatus('idle', parentHeader);
		}
	}

	async function handleControlMessage(
		socket: RouterSocket,
		peerId: Uint8Array,
		frames: Array<Uint8Array>,
	): Promise<void> {
		const msg = decodeMsg(frames);
		if (!(await hmacVerify(key, msg.signedParts, msg.sig))) return;

		const parentHeader = msg.header;
		const msgType = msg.header.msg_type;

		if (msgType === 'kernel_info_request')
			await socket.send(
				peerId,
				await encode('kernel_info_reply', kernelInfo(), parentHeader),
			);
		else if (msgType === 'shutdown_request') {
			const req = msg.content as { restart?: boolean };
			await socket.send(
				peerId,
				await encode(
					'shutdown_reply',
					{ restart: req.restart ?? false, status: 'ok' },
					parentHeader,
				),
			);
			shuttingDown = true;
			setTimeout(() => process.exit(0), 100);
		} else if (msgType === 'interrupt_request') {
			executor.interrupt();
			await socket.send(
				peerId,
				await encode('interrupt_reply', { status: 'ok' }, parentHeader),
			);
		}
	}

	async function shellLoop(): Promise<void> {
		while (true) {
			if (shuttingDown) break;
			const { peerId, frames } = await shell.recv();
			try {
				await handleShellMessage(shell, peerId, frames);
			} catch (error) {
				process.stderr.write(`${String(error)}\n`);
			}
		}
	}

	async function controlLoop(): Promise<void> {
		while (true) {
			if (shuttingDown) break;
			const { peerId, frames } = await control.recv();
			if (shuttingDown) break;
			try {
				await handleControlMessage(control, peerId, frames);
			} catch (error) {
				process.stderr.write(`${String(error)}\n`);
			}
		}
	}

	await Promise.all([shellLoop(), controlLoop()]);
}
