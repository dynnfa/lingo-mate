import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['tests/integration/speech-runtime.test.ts'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'tests/integration/**/*.test.{ts,tsx}']
  }
})
