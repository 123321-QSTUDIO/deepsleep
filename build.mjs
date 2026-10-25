import { build } from 'esbuild'
import fs from 'node:fs'

// 只构建独立服务形态：dist-service/index.mjs（CLI）+ dist-service/app.mjs（组装层，冒烟测试复用）
fs.rmSync('dist-service', { recursive: true, force: true })
fs.mkdirSync('dist-service', { recursive: true })

const banner = {
  js: [
    "import { createRequire as __deepsleepCreateRequire } from 'module';",
    "import { fileURLToPath as __deepsleepFileURLToPath } from 'url';",
    "import { dirname as __deepsleepDirname } from 'path';",
    "const require = __deepsleepCreateRequire(import.meta.url);",
    "const __filename = __deepsleepFileURLToPath(import.meta.url);",
    "const __dirname = __deepsleepDirname(__filename);",
  ].join(' '),
}

await build({
  entryPoints: { index: 'src/main.ts', app: 'src/app.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outdir: 'dist-service',
  outExtension: { '.js': '.mjs' },
  sourcemap: false,
  minify: false,
  loader: { '.html': 'text' },
  banner,
})

fs.copyFileSync('node_modules/sql.js/dist/sql-wasm.wasm', 'dist-service/sql-wasm.wasm')
console.log('build ok -> dist-service/ (独立服务；app.mjs 供冒烟测试 import)')
