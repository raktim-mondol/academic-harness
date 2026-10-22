/**
 * Client bundle build for academic-harness's Settings page.
 *
 * The web server serves one file per plugin (/plugins/academic-harness/client.js),
 * so the client half is one CJS bundle wrapped in the ModuleLoader factory
 * handshake — @deepseek-ai/dsh-* and react stay external (the profile's
 * healed node_modules and the app's module system provide them at runtime).
 * Built output is committed (lib/client.js) so installing the plugin needs
 * no build step or pnpm build-script approval.
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

mkdirSync('lib', { recursive: true })

const dshExternal = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-*']

await build({
  entryPoints: ['client/index.js'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  jsx: 'automatic',
  external: [...dshExternal, 'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'scheduler'],
  banner: {
    js: "window.__ModuleLoader__.load({ id: 'academic-harness', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
  },
  footer: {
    js: 'return module.exports; } });',
  },
  logLevel: 'info',
})
