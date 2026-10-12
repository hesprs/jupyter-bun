# Jupyter Bun

Modern TypeScript/JavaScript Jupyter kernel powered by Bun.

Currently there are no Bun-native Jupyter kernels, all Node-compatible kernels have been abandoned for years; the only choice was [Deno](https://github.com/denoland/deno), which needs to install yet another JavaScript runtime. So I made this project simply for "scratching an itch": make TypeScript + Jupyter Notebook work natively in Bun-primary workflows.

## Origin

The ZMTP transport and Jupyter protocol layer are ported from Deno's
[`cli/js/jupyter_kernel.js`](https://github.com/denoland/deno/blob/main/cli/js/jupyter_kernel.js)
(introduced in [PR #34083](https://github.com/denoland/deno/pull/34083), Jun 2026).

### Point of deviation

Ported from Deno commit [`c39f1798`](https://github.com/denoland/deno/commit/c39f1798db2a2ba097ff38d5942d208fe602bc28) (Jul 22, 2026).

## Usage

```sh
# Install kernelspec
bun jupyter-bun install

# Run kernel with a connection file
bun jupyter-bun <connection-file>
```

## Dependencies

- [`oxc-parser`](https://www.npmjs.com/package/oxc-parser) — Rust-native JS/TS parser for AST transforms
