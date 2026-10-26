import { defineConfig } from 'vitest/config'

// Explicit opt-in suite: missing preinstalled test resources is an error, never a skip.
export default defineConfig({
  test: { include: ['tests/integration/speech-runtime.test.ts'], testTimeout: 190_000 }
})
