import { Browser, Page, expect } from '@playwright/test';

/** Open a fresh browser context (own localStorage) for one player. */
export async function newPlayer(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

export async function createSession(page: Page, name: string): Promise<string> {
  await page.getByPlaceholder('Enter your name').fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Create a new session' }).click();
  const code = page.locator('.join-code__value');
  await expect(code).toHaveText(/^[A-Z0-9]{5}$/);
  return (await code.textContent())!.trim();
}

export async function joinSession(page: Page, name: string, code: string): Promise<void> {
  await page.getByPlaceholder('Enter your name').fill(name);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByPlaceholder('e.g. AXKF2').fill(code);
  await page.getByRole('button', { name: 'Join session' }).click();
  await expect(page.getByText('Waiting for the host to start')).toBeVisible();
}

/**
 * Act like a (random) player on whatever screen is shown: pick an option,
 * fill inputs, or click a button. Returns true if something was clicked.
 */
export async function actOnScreen(page: Page, cannedText = 'Paris'): Promise<boolean> {
  const options = page.locator('.mc__option:not([disabled])');
  if (await options.count()) {
    await options.nth(Math.floor(Math.random() * (await options.count()))).click();
    return true;
  }
  const inputs = page.locator('.ui-renderer input.field__input:not([disabled]), .ui-renderer textarea.field__input:not([disabled])');
  for (let i = 0; i < (await inputs.count()); i++) await inputs.nth(i).fill(cannedText);
  const buttons = page.locator('.ui-renderer button.btn:not([disabled])');
  if (await buttons.count()) {
    await buttons.first().click();
    return true;
  }
  return false;
}
