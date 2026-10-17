import type { Locator, Page } from '@playwright/test';

const COLLAPSED_GROUPS = '#app-nav nav button[aria-expanded="false"]';

/**
 * Open every collapsed sidebar group. Collapsed groups unmount their links, so a spec that
 * wants the full link list (or any link outside the default-open Queues group) must expand first.
 */
export async function expandNavGroups(page: Page): Promise<void> {
  const collapsed = page.locator(COLLAPSED_GROUPS);
  for (let remaining = await collapsed.count(); remaining > 0; remaining--) {
    await collapsed.first().click();
  }
}

/** Click a sidebar link, expanding collapsed groups one at a time until it is visible. */
export async function clickNavLink(page: Page, link: Locator): Promise<void> {
  const collapsed = page.locator(COLLAPSED_GROUPS);
  for (let remaining = await collapsed.count(); remaining > 0; remaining--) {
    if (await link.isVisible()) break;
    await collapsed.first().click();
  }
  await link.click();
}
