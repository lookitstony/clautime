// Builds the renderer as a static browser demo (real UI + mocked window.api)
// into docs/demo/ for GitHub Pages. Run with: npm run build:demo
import { resolve } from 'path'
import { renameSync, existsSync } from 'fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@': resolve('src/renderer/src')
    }
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'rename-demo-html',
      closeBundle() {
        const dir = resolve('docs/demo')
        if (existsSync(resolve(dir, 'demo.html'))) {
          renameSync(resolve(dir, 'demo.html'), resolve(dir, 'index.html'))
        }
      }
    }
  ],
  build: {
    outDir: resolve('docs/demo'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve('src/renderer/demo.html')
    }
  }
})
