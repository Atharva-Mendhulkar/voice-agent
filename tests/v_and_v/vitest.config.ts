import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@voice-agent/shared-types':   path.resolve(__dirname, '../../packages/shared-types/src'),
      '@voice-agent/redis-client':   path.resolve(__dirname, '../../packages/redis-client/src'),
      '@voice-agent/db-client':      path.resolve(__dirname, '../../packages/db-client/src'),
      '@voice-agent/pii-redactor':   path.resolve(__dirname, '../../packages/pii-redactor/src'),
      '@voice-agent/session-state':  path.resolve(__dirname, '../../packages/session-state/src'),
      '@voice-agent/eou-detector':   path.resolve(__dirname, '../../packages/eou-detector/src'),
      '@voice-agent/observability':  path.resolve(__dirname, '../../packages/observability/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [path.resolve(__dirname, './setup.ts')],
    // Unit: no infra needed — fast
    // Integration: boots testcontainers (Postgres, Redis, Temporal) — slow
    // E2E: full pipeline with mocked AI services — slowest
    testTimeout:  120_000,
    hookTimeout:  90_000,
    sequence: { concurrent: false },  // Avoid port conflicts between suites
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: [
        'packages/*/src/**',
        'apps/api-gateway/src/**',
        'workers/temporal-worker/src/**',
        'workers/agent-worker/src/**',
      ],
      thresholds: {
        lines:     80,
        functions: 80,
        branches:  75,
      },
    },
  },
});
