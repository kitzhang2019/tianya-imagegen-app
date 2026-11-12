import { defineConfig } from 'vite'

// base './' — relative asset paths so the build works when served from
// Capacitor's local server (capacitor:// / http://localhost).
export default defineConfig({
  base: './',
  server: { port: 5173 },
  preview: { port: 4173 },
})
