/**
 * ZMTP socket servers: ROUTER, PUB, REP.
 *
 * Adapted from Deno's jupyter_kernel.js. Each server type accepts TCP
 * connections, performs the ZMTP handshake, and provides the appropriate
 * messaging semantics.
 */

import type { Connection } from '@/connection';
import { listen } from '@/connection';
import { recvMultipart, sendFrames, zmtpHandshake } from '@/zmtp';

function makeQueue<T>() {
	const items: Array<T> = [];
	const waiters: Array<(item: T) => void> = [];
	return {
		pop(): Promise<T> {
			if (items.length > 0) {
				const item = items.shift();
				if (item) return Promise.resolve(item);
			}
			return new Promise((resolve) => {
				waiters.push(resolve);
			});
		},
		push(item: T) {
			const waiter = waiters.shift();
			if (waiter) waiter(item);
			else items.push(item);
		},
	};
}

/**
 * REP socket (heartbeat): echo back every received message.
 */
export function startHeartbeat(ip: string, port: number): void {
	listen(ip, port, (conn) => {
		void (async () => {
			try {
				await zmtpHandshake(conn, 'REP');
				while (true) {
					const frames = await recvMultipart(conn);
					await sendFrames(conn, frames);
				}
			} catch {
				// Peer disconnected
			} finally {
				conn.close();
			}
		})();
	});
}

type Peer = {
	conn: Connection;
	id: Uint8Array;
	key: string;
};

/**
 * ROUTER socket: per-connection peer tracking with incoming queue.
 * recv() returns { peerId, frames }. send(peerId, frames) routes to peer.
 */
export class RouterSocket {
	private readonly incoming = makeQueue<{ frames: Array<Uint8Array>; peerId: Uint8Array }>();
	private readonly peers = new Map<string, Peer>();

	constructor(ip: string, port: number) {
		listen(ip, port, (conn) => {
			void (async () => {
				const peerId = crypto.getRandomValues(new Uint8Array(5));
				const peerKey = [...peerId].join(',');
				try {
					await zmtpHandshake(conn, 'ROUTER');
					this.peers.set(peerKey, { conn, id: peerId, key: peerKey });
					while (true) {
						const frames = await recvMultipart(conn);
						this.incoming.push({ frames, peerId });
					}
				} catch {
					// Disconnected
				} finally {
					this.peers.delete(peerKey);
					conn.close();
				}
			})();
		});
	}

	get peerCount(): number {
		return this.peers.size;
	}

	recv(): Promise<{ frames: Array<Uint8Array>; peerId: Uint8Array }> {
		return this.incoming.pop();
	}

	async send(peerId: Uint8Array, frames: Array<Uint8Array>): Promise<void> {
		const peerKey = [...peerId].join(',');
		const peer = this.peers.get(peerKey);
		if (!peer) return;
		try {
			await sendFrames(peer.conn, frames);
		} catch {
			this.peers.delete(peerKey);
			peer.conn.close();
		}
	}

	async sendAll(frames: Array<Uint8Array>): Promise<void> {
		const dead: Array<string> = [];
		for (const [key, peer] of this.peers)
			try {
				await sendFrames(peer.conn, frames);
			} catch {
				dead.push(key);
			}
		for (const key of dead) {
			const peer = this.peers.get(key);
			this.peers.delete(key);
			peer?.conn.close();
		}
	}
}

/**
 * PUB socket: broadcast to all connected subscribers.
 */
export class PubSocket {
	private readonly conns = new Set<Connection>();

	constructor(ip: string, port: number) {
		listen(ip, port, (conn) => {
			void (async () => {
				try {
					await zmtpHandshake(conn, 'PUB');
					// SUB sockets send a SUBSCRIBE command; drain it
					await recvMultipart(conn);
					this.conns.add(conn);
					// Keep alive; SUB may re-subscribe
					while (true) await recvMultipart(conn);
				} catch {
					// Disconnected
				} finally {
					this.conns.delete(conn);
					conn.close();
				}
			})();
		});
	}

	async send(frames: Array<Uint8Array>): Promise<void> {
		const dead: Array<Connection> = [];
		for (const conn of this.conns)
			try {
				await sendFrames(conn, frames);
			} catch {
				dead.push(conn);
			}
		for (const conn of dead) {
			this.conns.delete(conn);
			conn.close();
		}
	}
}
