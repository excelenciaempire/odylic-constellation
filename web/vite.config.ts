/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev: Vite on 5177 proxies /api to the FastAPI backend on 8777.
// Prod: `npm run build` writes web/dist, which the backend serves at /.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5177,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:8777', changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
