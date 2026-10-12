/**
 * Bun TCP Connection wrapper.
 *
 * Bridges Bun's event-driven TCP socket API to the async reader pattern
 * used by the ZMTP code (adapted from Deno's jupyter_kernel.js).
 */

import type { Socket } from 'bun';

export type Connection = {
	close: () => void;
	readExact: (n: number) => Promise<Uint8Array>;
	readFrame: () => Promise<{ data: Uint8Array; hasMore: boolean; isCommand: boolean }>;
	write: (data: Uint8Array) => Promise<void>;
};

type Waiter = {
	needed: number;
	reject: (err: Error) => void;
	resolve: (data: Uint8Array) => void;
};

class ConnectionImpl implements Connection {
	private readonly chunks: Array<Uint8Array> = [];
	private bufferedLength = 0;
	private readonly waiters: Array<Waiter> = [];
	private closed = false;

	constructor(
		private readonly writeFn: (data: Uint8Array) => number,
		private readonly endFn: () => void,
	) {}

	feed(data: Uint8Array): void {
		if (this.closed) return;
		this.chunks.push(data);
		this.bufferedLength += data.length;
		this.drainWaiters();
	}

	private drainWaiters(): void {
		while (
			this.waiters.length > 0 &&
			this.bufferedLength >= (this.waiters[0]?.needed ?? Infinity)
		) {
			const waiter = this.waiters.shift();
			if (!waiter) break;
			waiter.resolve(this.consume(waiter.needed));
		}
	}

	private consume(n: number): Uint8Array {
		const result = new Uint8Array(n);
		let offset = 0;
		while (offset < n) {
			const chunk = this.chunks[0];
			if (!chunk) break;
			const remaining = n - offset;
			if (chunk.length <= remaining) {
				result.set(chunk, offset);
				offset += chunk.length;
				this.chunks.shift();
			} else {
				result.set(chunk.subarray(0, remaining), offset);
				this.chunks[0] = chunk.subarray(remaining);
				offset = n;
			}
		}
		this.bufferedLength -= n;
		return result;
	}

	readExact(n: number): Promise<Uint8Array> {
		if (this.closed) return Promise.reject(new Error('connection closed'));
		if (this.bufferedLength >= n) return Promise.resolve(this.consume(n));
		return new Promise((resolve, reject) => {
			this.waiters.push({ needed: n, reject, resolve });
		});
	}

	async readFrame(): Promise<{ data: Uint8Array; hasMore: boolean; isCommand: boolean }> {
		const flagBuf = await this.readExact(1);
		const flag = flagBuf[0] ?? 0;
		const isCommand = (flag & 0x04) !== 0;
		const isLong = (flag & 0x02) !== 0;
		const hasMore = (flag & 0x01) !== 0;

		let size: number;
		if (isLong) {
			const b = await this.readExact(8);
			size = new DataView(b.buffer).getUint32(4);
		} else {
			const b = await this.readExact(1);
			size = b[0] ?? 0;
		}

		const data = await this.readExact(size);
		return { data, hasMore, isCommand };
	}

	write(data: Uint8Array): Promise<void> {
		if (this.closed) return Promise.reject(new Error('connection closed'));
		this.writeFn(data);
		return Promise.resolve();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		while (this.waiters.length > 0) {
			const waiter = this.waiters.shift();
			waiter?.reject(new Error('connection closed'));
		}
		try {
			this.endFn();
		} catch {
			// Socket already closed
		}
	}
}

export function listen(
	ip: string,
	port: number,
	onConnect: (conn: Connection) => void,
): { stop: (closeConnections?: boolean) => void } {
	const conns = new Map<Socket, ConnectionImpl>();

	const server = Bun.listen({
		hostname: ip,
		port,
		socket: {
			close(socket: Socket) {
				const conn = conns.get(socket);
				if (conn) {
					conn.close();
					conns.delete(socket);
				}
			},
			data(socket: Socket, data: Uint8Array) {
				const conn = conns.get(socket);
				if (conn) conn.feed(data);
			},
			error(socket: Socket) {
				const conn = conns.get(socket);
				if (conn) {
					conn.close();
					conns.delete(socket);
				}
			},
			open(socket: Socket) {
				const conn = new ConnectionImpl(
					(data) => socket.write(data),
					() => socket.end(),
				);
				conns.set(socket, conn);
				onConnect(conn);
			},
		},
	});

	return {
		stop(closeConnections?: boolean) {
			if (closeConnections) for (const conn of conns.values()) conn.close();
			server.stop();
		},
	};
}

export async function connect(ip: string, port: number): Promise<Connection> {
	const connRef: { current?: ConnectionImpl } = {};
	const socket = await Bun.connect({
		hostname: ip,
		port,
		socket: {
			close() {
				connRef.current?.close();
			},
			data(_socket: Socket, data: Uint8Array) {
				connRef.current?.feed(data);
			},
			error() {
				connRef.current?.close();
			},
		},
	});
	const conn = new ConnectionImpl(
		(data) => socket.write(data),
		() => socket.end(),
	);
	connRef.current = conn;
	return conn;
}
