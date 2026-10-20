import { defineConfig } from 'vitest/config';

// Two projects: unit tests need nothing; integration tests need Postgres
// (TimescaleDB + PostGIS). `docker compose --profile test run --rm test`
// runs both against the compose database.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
