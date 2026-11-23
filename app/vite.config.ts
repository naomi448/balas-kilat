import { defineConfig } from 'vite'

// The G2 app is a thin shell: all state lives in the Balas Kilat backend.
// In dev, API calls are proxied to the backend on :8787 so the app can use
// same-origin relative paths (which is also how it runs when the backend
// serves app/dist statically in production).
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/digest': 'http://localhost:8787',
      '/draft': 'http://localhost:8787',
      '/send': 'http://localhost:8787',
      '/skip': 'http://localhost:8787',
      '/health': 'http://localhost:8787',
    },
  },
})
