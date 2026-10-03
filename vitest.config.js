import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.mjs'], fileParallelism: false, testTimeout: 30000, hookTimeout: 60000 } });
