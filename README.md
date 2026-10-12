# Jupyter Bun

Modern TypeScript/JavaScript Jupyter kernel powered by Bun.

## Origin

The ZMTP transport and Jupyter protocol layer are ported from Deno's
[`cli/js/jupyter_kernel.js`](https://github.com/denoland/deno/blob/main/cli/js/jupyter_kernel.js)
(introduced in [PR #34083](https://github.com/denoland/deno/pull/34083), Jun 2026).

### Point of deviation

Ported from Deno commit [`c39f1798`](https://github.com/denoland/deno/commit/c39f1798db2a2ba097ff38d5942d208fe602bc28) (Jul 22, 2026).

## Usage

```sh
# Install kernelspec
bun src/index.ts install

# Run kernel with a connection file
bun src/index.ts <connection-file>
```

## Test

```sh
bun test/client.ts
```

Custom ZMTP client exercises all channels: kernel_info, execute (TS, imports,
let re-declaration, await, destructuring, classes, functions, errors),
complete, is_complete.

## Dependencies

- [`oxc-parser`](https://www.npmjs.com/package/oxc-parser) — Rust-native JS/TS parser for AST transforms
