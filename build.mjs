import { build } from 'esbuild'
import fs from 'node:fs'

fs.rmSync('dist', { recursive: true, force: true })
fs.mkdirSync('dist', { recursive: true })

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'dist/index.mjs',
  sourcemap: false,
  minify: false,
  banner: {
    js: [
      "import { createRequire as __qqbotCreateRequire } from 'module';",
      "import { fileURLToPath as __qqbotFileURLToPath } from 'url';",
      "import { dirname as __qqbotDirname } from 'path';",
      "const require = __qqbotCreateRequire(import.meta.url);",
      "const __filename = __qqbotFileURLToPath(import.meta.url);",
      "const __dirname = __qqbotDirname(__filename);",
    ].join(' '),
  },
})

fs.copyFileSync('node_modules/sql.js/dist/sql-wasm.wasm', 'dist/sql-wasm.wasm')

fs.writeFileSync(
  'dist/package.json',
  JSON.stringify(
    {
      name: 'napcat-plugin-qqbot',
      plugin: 'DeepSleep 群机器人',
      version: '0.1.0',
      type: 'module',
      main: 'index.mjs',
    },
    null,
    2
  )
)

console.log('build ok -> dist/')
