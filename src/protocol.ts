/**
 * Jupyter wire protocol: HMAC-SHA256 signing, message encode/decode.
 *
 * Ported from Deno's cli/js/jupyter_kernel.js — pure JS using
 * crypto.subtle. No native dependencies.
 */

const ENC = new TextEncoder();
const DEC = new TextDecoder();

const DELIMITER = ENC.encode('<IDS|MSG>');

export type JupyterHeader = {
	date: string;
	msg_id: string;
	msg_type: string;
	session: string;
	username: string;
	version: string;
};

export type JupyterMessage = {
	buffers: Array<Uint8Array>;
	content: unknown;
	header: JupyterHeader;
	identities: Array<Uint8Array>;
	metadata: Record<string, unknown>;
	parentHeader: Record<string, unknown>;
	sig: string;
	signedParts: Array<Uint8Array>;
};

async function hmacSign(key: string, parts: Array<Uint8Array>): Promise<string> {
	if (!key || key.length === 0) return '';
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		ENC.encode(key) as BufferSource,
		{ hash: 'SHA-256', name: 'HMAC' },
		false,
		['sign'],
	);
	const combined = combineParts(parts);
	const sig = await crypto.subtle.sign('HMAC', cryptoKey, combined as BufferSource);
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function combineParts(parts: Array<Uint8Array>): Uint8Array {
	const combined = new Uint8Array(parts.reduce((acc, p) => acc + p.length, 0));
	let offset = 0;
	for (const p of parts) {
		combined.set(p, offset);
		offset += p.length;
	}
	return combined;
}

export async function hmacVerify(
	key: string,
	parts: Array<Uint8Array>,
	sig: string,
): Promise<boolean> {
	if (!key || key.length === 0) return true;
	if (typeof sig !== 'string' || sig.length === 0 || sig.length % 2 !== 0) return false;
	const sigBytes = new Uint8Array(sig.length / 2);
	for (let i = 0; i < sigBytes.length; i++) {
		const byte = Number.parseInt(sig.slice(i * 2, i * 2 + 2), 16);
		if (Number.isNaN(byte)) return false;
		sigBytes[i] = byte;
	}
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		ENC.encode(key) as BufferSource,
		{ hash: 'SHA-256', name: 'HMAC' },
		false,
		['verify'],
	);
	return crypto.subtle.verify('HMAC', cryptoKey, sigBytes, combineParts(parts) as BufferSource);
}

function makeHeader(session: string, msgType: string): string {
	return JSON.stringify({
		date: new Date().toISOString(),
		msg_id: crypto.randomUUID(),
		msg_type: msgType,
		session,
		username: 'kernel',
		version: '5.3',
	});
}

type EncodeExtra = {
	buffers?: Array<Uint8Array>;
	identities?: Array<Uint8Array>;
	metadata?: Record<string, unknown>;
};

export function makeEncoder(session: string, key: string) {
	return async (
		msgType: string,
		content: unknown,
		parentHeader: Record<string, unknown> = {},
		extra: EncodeExtra = {},
	): Promise<Array<Uint8Array>> => {
		const header = makeHeader(session, msgType);
		const parentHeaderStr = JSON.stringify(parentHeader);
		const metaStr = JSON.stringify(extra.metadata ?? {});
		const contentStr = JSON.stringify(content);

		const parts = [header, parentHeaderStr, metaStr, contentStr].map((s) => ENC.encode(s));
		const sig = await hmacSign(key, parts);

		return [
			...(extra.identities ?? []),
			DELIMITER,
			ENC.encode(sig),
			ENC.encode(header),
			ENC.encode(parentHeaderStr),
			ENC.encode(metaStr),
			ENC.encode(contentStr),
			...(extra.buffers ?? []),
		];
	};
}

export function decodeMsg(frames: Array<Uint8Array>): JupyterMessage {
	let delimIdx = -1;
	for (let i = 0; i < frames.length; i++) {
		const frame = frames[i];
		if (frame.length === DELIMITER.length) {
			let match = true;
			for (let j = 0; j < DELIMITER.length; j++)
				if (frame[j] !== DELIMITER[j]) {
					match = false;
					break;
				}
			if (match) {
				delimIdx = i;
				break;
			}
		}
	}

	if (delimIdx === -1) throw new Error('no <IDS|MSG> delimiter');

	const identities = frames.slice(0, delimIdx);
	const sig = DEC.decode(frames[delimIdx + 1]);
	const signedParts = frames.slice(delimIdx + 2, delimIdx + 6);
	const header = JSON.parse(DEC.decode(frames[delimIdx + 2])) as JupyterHeader;
	const parentHeader = JSON.parse(DEC.decode(frames[delimIdx + 3])) as Record<string, unknown>;
	const metadata = JSON.parse(DEC.decode(frames[delimIdx + 4])) as Record<string, unknown>;
	const content = JSON.parse(DEC.decode(frames[delimIdx + 5])) as unknown;
	const msgBuffers = frames.slice(delimIdx + 6);

	return {
		buffers: msgBuffers,
		content,
		header,
		identities,
		metadata,
		parentHeader,
		sig,
		signedParts,
	};
}

export { DEC, ENC };
