import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

// base './' — relative asset paths so the build works when served from
// Capacitor's local server (capacitor:// / http://localhost).
//
// __APP_VERSION__：版本号取自 package.json（与 iOS MARKETING_VERSION、
// Android versionName 同源改动），构建时打进包里，设置页“版本”一行显示用。
// 以后发版只改 package.json 里的 version，设置页自动跟着变，不用手写。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

export default defineConfig({
  base: './',
  server: { port: 5173 },
  preview: { port: 4173 },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
})
