import { test, expect, Page } from '@playwright/test';
import { newPlayer, createSession, joinSession, actOnScreen } from './helpers';

// Plays real games in the browser against a LOCAL model (Ollama). Slow.
// Run with: npm run e2e:llm   (HEADED=1 to watch the browsers)

async function defineWithPreset(host: Page, presetTitle: string): Promise<void> {
  await host.getByRole('button', { name: 'Define the game' }).click();
  await host.locator('.preset-card', { hasText: presetTitle }).click();
  // The model may ask a question first; nudge it to propose.
  const startButton = host.getByRole('button', { name: 'Start game' });
  for (let i = 0; i < 3 && !(await startButton.isVisible()); i++) {
    await expect(host.locator('.page--chat')).not.toContainText('AI is thinking', { timeout: 5 * 60_000 });
    if (await startButton.isVisible()) break;
    await host.locator('.chat-input__field').fill('Use sensible defaults and propose the rules now.');
    await host.locator('.chat-input__field').press('Enter');
    await host.waitForTimeout(2000);
  }
  await expect(startButton).toBeVisible();
  await startButton.click();
}

/** Let every player act on their screen until the game-over overlay appears. */
async function playUntilGameOver(players: Page[], maxMinutes: number): Promise<void> {
  const deadline = Date.now() + maxMinutes * 60_000;
  while (Date.now() < deadline) {
    if (await players[0].locator('.game-over-panel').isVisible()) return;
    for (const page of players) {
      // Retry a stalled turn if the AI gave up
      const retry = page.getByRole('button', { name: 'Retry' });
      if (await retry.isVisible()) await retry.click();
      if (!(await page.locator('.thinking-pill').isVisible())) await actOnScreen(page);
    }
    await players[0].waitForTimeout(1500);
  }
  throw new Error(`Game did not finish within ${maxMinutes} minutes`);
}

test('single player: Flash Memory runs to the end', async ({ browser }) => {
  const ana = await newPlayer(browser);
  await createSession(ana, 'Ana');
  await defineWithPreset(ana, 'Flash Memory');
  await expect(ana.locator('.ui-renderer')).not.toBeEmpty();
  await playUntilGameOver([ana], 10);
  await expect(ana.locator('.game-over-panel')).toBeVisible();
});

test('two players: Quiz Battle runs to the end', async ({ browser }) => {
  const ana = await newPlayer(browser);
  const bob = await newPlayer(browser);
  const code = await createSession(ana, 'Ana');
  await joinSession(bob, 'Bob', code);
  await defineWithPreset(ana, 'Quiz Battle');
  await expect(bob.locator('.ui-renderer')).not.toBeEmpty();
  await playUntilGameOver([ana, bob], 15);
  await expect(bob.locator('.game-over-panel')).toBeVisible();
});
