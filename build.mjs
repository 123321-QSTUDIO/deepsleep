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

// 独立服务模式（OneBot v11 WS，不依赖 NapCat 插件机制）
fs.rmSync('dist-service', { recursive: true, force: true })
fs.mkdirSync('dist-service', { recursive: true })
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'dist-service/index.mjs',
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
fs.copyFileSync('node_modules/sql.js/dist/sql-wasm.wasm', 'dist-service/sql-wasm.wasm')

console.log('build ok -> dist/ (插件) + dist-service/ (独立服务)')
