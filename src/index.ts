#!/usr/bin/env bun
/**
 * Bun-jupyter-ts-kernel — TypeScript Jupyter kernel powered by Bun.
 *
 * Usage:
 *   bun src/index.ts <connection-file>   Run kernel
 *   bun src/index.ts install             Install kernelspec
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import startKernel from '@/kernel';

const args = process.argv.slice(2);

if (args[0] === 'install') {
	const scriptPath = import.meta.path;
	const kernelspecDir = join(
		process.env.HOME ?? '~',
		'.local/share/jupyter/kernels/typescript-bun',
	);
	mkdirSync(kernelspecDir, { recursive: true });
	const kernelJson = {
		argv: ['bun', scriptPath, '{connection_file}'],
		display_name: 'TypeScript (Bun)',
		language: 'typescript',
	};
	writeFileSync(join(kernelspecDir, 'kernel.json'), JSON.stringify(kernelJson, undefined, 2));
	console.log(`Installed kernelspec to ${kernelspecDir}`);
	process.exit(0);
}

if (!args[0]) {
	console.error('Usage: bun src/index.ts <connection-file>');
	console.error('       bun src/index.ts install');
	process.exit(1);
}

const connectionFile = args[0];
await startKernel(connectionFile);
