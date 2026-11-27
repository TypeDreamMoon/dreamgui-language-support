/**
 * One bundle: the extension host loads out/extension.js and nothing else, so node_modules never
 * ships. `vscode` is external because the editor injects it at load time; it exists on no disk.
 * `node:sqlite` likewise belongs to the host's Node.
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
	// node:sqlite is the host's own (Node >= 22.13), required lazily; bundling cannot supply it.
	external: ['vscode', 'node:sqlite'],
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
