/**
 * One bundle: the extension host loads out/extension.js and nothing else, so node_modules never
 * ships. `vscode` is external because the editor injects it at load time; it exists on no disk.
 */
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const options = {
	entryPoints: ['src/extension.ts'],
	outfile: 'out/extension.js',
	bundle: true,
	format: 'cjs',
	platform: 'node',
	target: 'node18',
	external: ['vscode'],
	sourcemap: !production,
	minify: production,
	logLevel: 'info',
};

(async () => {
	if (watch) {
		const context = await esbuild.context(options);
		await context.watch();
	} else {
		await esbuild.build(options);
	}
})().catch(() => process.exit(1));
