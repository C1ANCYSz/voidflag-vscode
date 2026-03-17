import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  external: ['vscode'], // vscode API must never be bundled
  sourcemap: true,
  minify: !watch,
};

const ctx = await esbuild.context({
  ...shared,
  entryPoints: ['src/extension.ts', 'src/server.ts'],
  outdir: 'dist',
  format: 'cjs', // VS Code extension host requires CJS
});

if (watch) {
  await ctx.watch();
  console.log('Watching...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
