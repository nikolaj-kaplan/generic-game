import { test, expect } from '@playwright/test';
import { newPlayer, createSession, joinSession } from './helpers';

// Runs against the scripted mock LLM (e2e/mock-llm.ts): fast and deterministic.

test('two players: secret screen, wait for all, results, game over', async ({ browser }) => {
  const ana = await newPlayer(browser);
  const bob = await newPlayer(browser);

  const code = await createSession(ana, 'Ana');
  await joinSession(bob, 'Bob', code);
  await expect(ana.locator('.player-list').getByText('Bob')).toBeVisible();

  // Definition phase
  await ana.getByRole('button', { name: 'Define the game' }).click();
  await ana.locator('.chat-input__field').fill('A one-question quiz for two players');
  await ana.locator('.chat-input__field').press('Enter');
  await expect(ana.getByText('Proposed rules')).toBeVisible();
  await ana.getByRole('button', { name: 'Start game' }).click();

  // Per-player screens: only Ana gets the hint
  await expect(ana.getByText('Psst: the answer is 4')).toBeVisible();
  await expect(bob.getByText('Question 1')).toBeVisible();
  await expect(bob.getByText('Psst')).toHaveCount(0);
  await expect(ana.locator('.countdown')).toBeVisible();

  // Game state never reaches the browser
  const bobHtml = await bob.content();
  expect(bobHtml).not.toContain('correct_answer');

  // Ana answers first: her screen locks, her timer stops, and Bob gets a small notification
  await ana.getByRole('button', { name: '4', exact: true }).click();
  await expect(ana.getByText('Your answer is in')).toBeVisible();
  await expect(ana.getByText('✓ Correct! (+1)')).toBeVisible();
  await expect(ana.locator('.countdown')).toHaveCount(0);
  expect(await bob.content()).not.toContain('answerKey');
  await expect(bob.locator('.toast')).toHaveText('Ana answered ✓');
  await expect(bob.locator('.countdown')).toBeVisible();
  await expect(ana.getByText('Waiting for Bob')).toBeVisible();
  await expect(bob.getByText('Waiting for Bob')).toBeVisible();

  // Bob answers: both see the results
  await bob.getByRole('button', { name: '5', exact: true }).click();
  await expect(ana.getByText('Results')).toBeVisible();
  await expect(bob.getByText('Results')).toBeVisible();
  await expect(bob.locator('.scoreboard')).toBeVisible();

  // Only the host continues past a results screen
  await expect(bob.getByRole('button', { name: 'Next' })).toHaveCount(0);
  await ana.getByRole('button', { name: 'Next' }).click();
  await expect(ana.getByText('Mock game over!')).toBeVisible();
  await expect(bob.getByText('Mock game over!')).toBeVisible();
  await expect(ana.getByRole('button', { name: 'Play again 🔄' })).toBeVisible();
  await expect(bob.getByText('Waiting for the host')).toBeVisible();

  // After game over the host can still change the game: the AI patches the
  // program, the host approves the change, and everyone gets the new end screen
  await ana.getByRole('button', { name: /Adjust/ }).click();
  await ana.locator('.tweak-bar__input').fill('Add a final screen with the score of each question');
  await ana.locator('.tweak-bar__input').press('Enter');
  await expect(ana.getByText('Adds a score summary to the end screen.')).toBeVisible();
  await expect(bob.getByText('Proposed change')).toHaveCount(0);
  await ana.getByRole('button', { name: 'Apply' }).click();
  await expect(bob.getByText('Score per question')).toBeVisible();
  await expect(bob.getByText('Mock game over!')).toBeVisible();

  // After a reload the host can still restart a finished game
  await ana.reload();
  await expect(ana.getByRole('button', { name: 'Play again 🔄' })).toBeVisible();
  await expect(ana.getByText('session has already ended')).toHaveCount(0);
  await ana.getByRole('button', { name: 'Play again 🔄' }).click();
  await expect(ana.getByRole('button', { name: 'Start game' })).toBeVisible();
});

test('a reloaded player gets their current screen back', async ({ browser }) => {
  const ana = await newPlayer(browser);
  await createSession(ana, 'Ana');
  await ana.getByRole('button', { name: 'Define the game' }).click();
  await ana.locator('.chat-input__field').fill('quiz');
  await ana.locator('.chat-input__field').press('Enter');
  await ana.getByRole('button', { name: 'Start game' }).click();
  await expect(ana.getByText('Question 1')).toBeVisible();

  await ana.reload();
  await expect(ana.getByText('Question 1')).toBeVisible();
  await expect(ana.getByText('Psst: the answer is 4')).toBeVisible();
  await expect(ana.locator('.countdown')).toBeVisible();
});

test('rules need enough players; saved rules can be reused later', async ({ browser }) => {
  const ana = await newPlayer(browser);
  const code = await createSession(ana, 'Ana');
  await ana.getByRole('button', { name: 'Define the game' }).click();
  await ana.locator('.chat-input__field').fill('A quiz for two players');
  await ana.locator('.chat-input__field').press('Enter');

  // Defined alone: Start waits for a second player, who can join during setup
  await expect(ana.getByText('Needs 2–8 players · 1 joined')).toBeVisible();
  await expect(ana.getByRole('button', { name: 'Start game' })).toHaveCount(0);
  const bob = await newPlayer(browser);
  await bob.getByPlaceholder('Enter your name').fill('Bob');
  await bob.getByRole('button', { name: 'Continue' }).click();
  await bob.getByPlaceholder('e.g. AXKF2').fill(code);
  await bob.getByRole('button', { name: 'Join session' }).click();
  await expect(ana.getByText('👋 Bob joined')).toBeVisible();
  await expect(ana.getByRole('button', { name: 'Start game' })).toBeVisible();

  // Play to the end, save the rules
  await ana.getByRole('button', { name: 'Start game' }).click();
  await ana.getByRole('button', { name: '4', exact: true }).click();
  await bob.getByRole('button', { name: '4', exact: true }).click();
  await ana.getByRole('button', { name: 'Next' }).click();
  await ana.getByRole('button', { name: /Save “Mock Quiz” for next time/ }).click();
  await expect(ana.getByRole('button', { name: /Saved as “Mock Quiz”/ })).toBeVisible();

  // Back in the lobby, the saved game loads without the AI chat
  await ana.getByRole('button', { name: 'Back to waiting room' }).click();
  await ana.getByRole('button', { name: 'Define the game' }).click();
  await ana.locator('.saved-game', { hasText: 'Mock Quiz' }).locator('.preset-card').click();
  await expect(ana.getByText('Saved rules loaded')).toBeVisible();
  await expect(ana.getByRole('button', { name: 'Start game' })).toBeVisible();

  // The program was saved with the rules and starts right away
  await ana.getByRole('button', { name: 'Start game' }).click();
  await expect(ana.getByText('Question 1')).toBeVisible();
});

test('when the timer runs out the game moves on', async ({ browser }) => {
  const ana = await newPlayer(browser);
  await createSession(ana, 'Ana');
  await ana.getByRole('button', { name: 'Define the game' }).click();
  await ana.locator('.chat-input__field').fill('A quick quiz');
  await ana.locator('.chat-input__field').press('Enter');
  await ana.getByRole('button', { name: 'Start game' }).click();
  await expect(ana.getByText('Question 1')).toBeVisible();
  await expect(ana.getByText('Results')).toBeVisible({ timeout: 5000 });
  await expect(ana.getByText('(no answers)')).toBeVisible();
});

test('players can leave the waiting room; the host role moves on', async ({ browser }) => {
  const ana = await newPlayer(browser);
  const code = await createSession(ana, 'Ana');
  const bob = await newPlayer(browser);
  await joinSession(bob, 'Bob', code);

  await ana.getByRole('button', { name: 'Leave' }).click();
  await expect(ana.getByRole('button', { name: 'Create a new session' })).toBeVisible();
  // Bob is host now and can start defining
  await expect(bob.getByRole('button', { name: 'Define the game' })).toBeVisible();
  await expect(bob.locator('.player-list').getByText('Ana')).toHaveCount(0);
});
