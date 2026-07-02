import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // tts.worker.js dynamically imports kokoro-js, which requires ES module output for workers
  // (the default 'iife' format doesn't support code-split chunks).
  worker: {
    format: 'es',
  },
})
