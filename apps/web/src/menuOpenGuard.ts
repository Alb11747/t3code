let generation = 0;

/**
 * Fork: thread menus wait for their snooze options before they show. A later open, a close or a
 * thread change makes an earlier waiting open stale; check `isCurrent` after the wait.
 */
export function startMenuOpen(): { readonly isCurrent: () => boolean } {
  const token = ++generation;
  return { isCurrent: () => token === generation };
}

export function cancelPendingMenuOpen(): void {
  generation += 1;
}
