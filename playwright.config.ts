import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/electron',
  testMatch: '**/*.pw.ts',
  workers: 1
})
