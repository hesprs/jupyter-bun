# Jupyter Bun

Modern TypeScript/JavaScript Jupyter kernel powered by Bun.

## Origin

The ZMTP transport and Jupyter protocol layer are ported from Deno's
[`cli/js/jupyter_kernel.js`](https://github.com/denoland/deno/blob/main/cli/js/jupyter_kernel.js)
(introduced in [PR #34083](https://github.com/denoland/deno/pull/34083), Jun 2026).

Ported from Deno commit [`c39f1798`](https://github.com/denoland/deno/commit/c39f1798db2a2ba097ff38d5942d208fe602bc28) (Jul 22, 2026).

## Usage

```sh
bun install -g jupyter-bun
# Install kernelspec
jupyter-bun install
```

## Cell Output Methods

Usage sample see [`sample.ipynb`](./sample.ipynb).

### 1. Console and `stdout`/`stderr`

All `console.*` calls and `process.stdout.write()` / `process.stderr.write()` calls are captured.

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

### 2. Interactive Input

`prompt()` and `confirm()` request interactive input from the user.

Both are **asynchronous**, you must `await` them.

```typescript
// Prompt
const name = await prompt('Enter name:');
// Frontend shows input box, returns user input as string

// Confirm (returns boolean)
const ok = await confirm('Delete file?');
// Frontend shows [y/N] prompt → returns true/false
```

### 3. Rich Display

`display()` sends MIME bundles to the frontend. Supports `update` for in-place output updates.

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

### 4. Bare Expressions

Bare expression results are displayed as plaintext:

```typescript
1 + 1           // → execute_result: { 'text/plain': '2' }
'hello'         // → execute_result: { 'text/plain': 'hello' }
{ a: 1, b: 2 }  // → execute_result: { 'text/plain': '{ a: 1, b: 2 }' }
```
