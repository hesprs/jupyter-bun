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

## Cell Output Methods

### 1. Console and stdout/stderr

All `console.*` calls and `process.stdout.write()` / `process.stderr.write()` calls are captured and sent as `stream` messages on the iopub channel.

```typescript
// Console methods
console.log('hello'); // → stream: stdout
console.error('oops'); // → stream: stderr
console.warn('warning'); // → stream: stderr
console.info('info'); // → stream: stdout

// Raw stream writes
process.stdout.write('raw stdout'); // → stream: stdout
process.stderr.write('raw stderr'); // → stream: stderr
```

### 2. Interactive input: `prompt()` and `confirm()`

`prompt()` and `confirm()` are overridden during cell execution (when `allow_stdin: true`). They send `input_request` on the stdin channel and wait for `input_reply` from the frontend.

Both are **async** — you must `await` them.

```typescript
// Prompt
const name = await prompt('Enter name:');
// Frontend shows input box, returns user input as string

// Confirm (returns boolean)
const ok = await confirm('Delete file?');
// Frontend shows [y/N] prompt → returns true/false
```

### 3. Rich display: `display()`

`display()` sends MIME bundles to the frontend as `display_data` messages. Supports `update_display_data` for in-place output updates.

```typescript
// Display HTML
display({ 'text/html': '<b>Hello</b>' });

// Display Markdown
display({ 'text/markdown': '# Heading\n\nParagraph text' });

// Display with display_id for later updates
display({ 'text/html': '<p>Loading: 0%</p>' }, { display_id: 'progress' });

// Update the same output in-place (no new cell created)
display({ 'text/html': '<p>Loading: 50%</p>' }, { display_id: 'progress', update: true });
```

Objects implementing `[Symbol.for('Jupyter.display')]` are automatically rendered as rich MIME bundles when used as the last expression in a cell:

```typescript
class Chart {
  [Symbol.for('Jupyter.display')]() {
    return { 'image/svg+xml': '<svg>...</svg>' };
  }
}

new Chart(); // → execute_result with image/svg+xml
```

Bare expressions are sent as `execute_result` messages with `text/plain` MIME (via `Bun.inspect`):

```typescript
1 + 1           // → execute_result: { 'text/plain': '2' }
'hello'         // → execute_result: { 'text/plain': 'hello' }
{ a: 1, b: 2 }  // → execute_result: { 'text/plain': '{ a: 1, b: 2 }' }
```

## Dependencies

- [`oxc-parser`](https://www.npmjs.com/package/oxc-parser) — Rust-native JS/TS parser for AST transforms
