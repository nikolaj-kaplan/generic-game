import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // dist/ holds compiled copies of the tests after `npm run build`
    exclude: ['dist/**', 'node_modules/**'],
  },
});
