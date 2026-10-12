/**
 * ZMTP 3.0 framing + NULL handshake.
 *
 * Ported from Deno's cli/js/jupyter_kernel.js. Uses the Connection
 * abstraction from connection.ts instead of Deno's raw TCP.
 */

import type { Connection } from '@/connection';

const ENC = new TextEncoder();

/**
 * Make a ZMTP short or long frame.
 * - more: whether more frames follow
 * - isCommand: whether this is a ZMTP command frame
 */
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

/**
 * Coalesce all ZMTP frames into a single buffer and write.
 * libzmq peers send each message as one TCP write; emitting many
 * small writes interacts badly with Nagle/delayed-ACK.
 */
export async function sendFrames(conn: Connection, frames: Array<Uint8Array>): Promise<void> {
	const encoded = frames.map((frame, i) => makeFrame(frame, i < frames.length - 1));
	const total = encoded.reduce((acc, f) => acc + f.length, 0);
	const buf = new Uint8Array(total);
	let offset = 0;
	for (const f of encoded) {
		buf.set(f, offset);
		offset += f.length;
	}
	await conn.write(buf);
}

/**
 * Read a multipart ZMTP message (all frames until hasMore is false).
 */
export async function recvMultipart(conn: Connection): Promise<Array<Uint8Array>> {
	const frames: Array<Uint8Array> = [];
	while (true) {
		const { data, hasMore } = await conn.readFrame();
		frames.push(data);
		if (!hasMore) break;
	}
	return frames;
}

/**
 * 64-octet ZMTP greeting: signature (0xff, 8 zero pad, 0x7f), version 3.0,
 * 20-octet mechanism ("NULL"), as-server flag, 31 filler octets.
 */
function makeGreeting(): Uint8Array {
	const buf = new Uint8Array(64);
	buf[0] = 0xff;
	buf[9] = 0x7f;
	buf[10] = 0x03;
	buf[11] = 0x00;
	buf.set(ENC.encode('NULL'), 12);
	buf[32] = 0x00;
	return buf;
}

/**
 * ZMTP READY command with Socket-Type metadata.
 */
function makeReadyCommand(socketType: string): Uint8Array {
	const sockBytes = ENC.encode(socketType);
	const nameBytes = ENC.encode('READY');
	const propName = ENC.encode('Socket-Type');

	const propLen = 1 + propName.length + 4 + sockBytes.length;
	const body = new Uint8Array(1 + nameBytes.length + propLen);
	let o = 0;
	body[o++] = nameBytes.length;
	body.set(nameBytes, o);
	o += nameBytes.length;
	body[o++] = propName.length;
	body.set(propName, o);
	o += propName.length;
	new DataView(body.buffer).setUint32(o, sockBytes.length);
	o += 4;
	body.set(sockBytes, o);

	return makeFrame(body, false, true);
}

/**
 * Exchange greeting + READY commands with the peer (NULL security).
 */
export async function zmtpHandshake(conn: Connection, socketType: string): Promise<void> {
	await conn.write(makeGreeting());
	// Read peer's 64-octet greeting
	await conn.readExact(64);
	// Exchange READY commands
	await conn.write(makeReadyCommand(socketType));
	await conn.readFrame();
}
