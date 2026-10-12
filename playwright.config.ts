import { defineConfig } from '@playwright/test';

/**
 * Browser tests. Both modes only ever talk to an LLM on localhost:
 *
 *   npm run e2e       scripted mock LLM (fast, deterministic UI + protocol checks)
 *   npm run e2e:llm   real local model through Ollama (slow, plays a full game)
 *
 * The game server runs with LLM_LOCAL_ONLY=1, so it refuses any non-local
 * endpoint even if .env points at OpenRouter.
 */
const useLocalLlm = process.env.E2E_LLM === '1';
const port = useLocalLlm ? 3196 : 3197;
const model = process.env.PLAYTEST_MODEL ?? 'gemma4:26b-a4b-it-qat';

const serverEnv: Record<string, string> = {
  PORT: String(port),
  DATA_DIR: `../data/e2e/${useLocalLlm ? 'llm' : 'mock'}`,
  LLM_LOCAL_ONLY: '1',
  // Ignore models.json: tests never use the strong (bridge) model.
  GAME_MODELS_FILE: 'none',
  LLM_API_KEY: '',
  OPENROUTER_API_KEY: '',
  LLM_PROTOCOL: 'json',
  ...(useLocalLlm
    ? { LLM_BASE_URL: 'http://localhost:11434/v1', LLM_MODEL: model, LLM_REASONING_EFFORT: process.env.PLAYTEST_REASONING ?? 'none' }
    : { LLM_BASE_URL: 'http://localhost:11998/v1', LLM_MODEL: 'mock', LLM_REASONING_EFFORT: '' }),
};

const gameServer = {
  command: 'npm run build --prefix client && cd server && npx tsx src/index.ts',
  url: `http://localhost:${port}/health`,
  env: serverEnv,
  reuseExistingServer: false,
  timeout: 120_000,
  stdout: 'pipe' as const,
};

export default defineConfig({
  testDir: './e2e',
  testMatch: useLocalLlm ? /.*\.llm\.spec\.ts/ : /.*\.mock\.spec\.ts/,
  timeout: useLocalLlm ? 20 * 60_000 : 60_000,
  expect: { timeout: useLocalLlm ? 5 * 60_000 : 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'data/e2e/test-results',
  use: {
    baseURL: `http://localhost:${port}`,
    channel: 'chrome',
    headless: process.env.HEADED !== '1',
    trace: 'retain-on-failure',
  },
  webServer: useLocalLlm
    ? [gameServer]
    : [
        {
          command: 'npx tsx e2e/mock-llm.ts',
          url: 'http://localhost:11998/health',
          reuseExistingServer: false,
          timeout: 30_000,
        },
        gameServer,
      ],
});
