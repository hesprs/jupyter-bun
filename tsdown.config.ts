import { defineConfig } from 'tsdown';

export default defineConfig({
	css: { minify: true },
	dts: false,
	entry: 'src/index.ts',
	minify: true,
	outExtensions: () => ({ js: '.js' }),
});
