import { defineConfig } from 'tsdown'

const PACKAGE_ID = 'dsh-session-manager'

export default defineConfig([
  {
    name: PACKAGE_ID,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      // Every @deepseek-ai package is shipped by the DSH host and must stay
      // EXTERNAL: bundling copies breaks module-level state sharing (dsh-scope's
      // scope-parent map, cordis symbols/instanceof identity), which makes
      // cross-plugin APIs like serviceForAgent silently return undefined.
      onlyBundle: [],
    },
  },
  {
    name: `${PACKAGE_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      neverBundle: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
