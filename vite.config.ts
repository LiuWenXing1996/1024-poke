/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: { open: true },   // npm run dev 自动打开浏览器
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
  },
})
