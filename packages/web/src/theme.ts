/**
 * Light / dark, and the third state people forget.
 *
 * A browser has three states, not two: the reader picked light, the reader picked dark,
 * or the reader picked nothing and the OS decides. Only the third one is the default, so
 * it is the one the stylesheet has to work in — `prefers-color-scheme` with no attribute
 * on the root.
 *
 * The button exists for the reader who wants to override the OS for this tab, which is
 * the normal case for a review tool: the document is read at a desk at noon and again in
 * bed at midnight, and the OS is not always right about which one it is.
 *
 * Separate from app.ts so it can be tested. app.ts reads argv-equivalent (the DOM) and
 * starts running on import; nothing here touches either.
 */

/** The three states. `auto` means "no choice recorded" — the OS decides. */
export type Theme = 'auto' | 'light' | 'dark';

/**
 * The cycle the button walks. `auto` is first because it is where everyone starts, and
 * pressing three times has to come back to it — a reader who overrode by accident needs
 * a way back to the OS that does not involve clearing site data.
 */
export const THEME_ORDER: readonly Theme[] = ['auto', 'light', 'dark'] as const;

/** Where the choice is kept. Namespaced because the origin is shared by every akapen on this host. */
export const THEME_KEY = 'akapen.theme';

/** The next state in the cycle. Anything unrecognised restarts at `auto`. */
export function nextTheme(current: Theme): Theme {
  const i = THEME_ORDER.indexOf(current);
  return THEME_ORDER[(i + 1) % THEME_ORDER.length] ?? 'auto';
}

/**
 * A stored string turned back into a state.
 *
 * Anything that is not one of the three is `auto`, not an error: the value comes from a
 * shared origin that other akapen versions also write to, so a string from a future or
 * past build must degrade to the default rather than break the page.
 */
export function parseTheme(raw: string | null | undefined): Theme {
  return raw === 'light' || raw === 'dark' ? raw : 'auto';
}

/** The subset of Storage this module uses, so tests can pass a fake — and a throwing one. */
export type ThemeStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/**
 * The recorded choice.
 *
 * Reading storage throws outright in some contexts (a private window, a browser set to
 * block site data). That must not stop the document from rendering, so a throw is the
 * same as "nothing recorded".
 */
export function readTheme(store: ThemeStore | null | undefined): Theme {
  if (!store) return 'auto';
  try {
    return parseTheme(store.getItem(THEME_KEY));
  } catch {
    return 'auto';
  }
}

/**
 * Record the choice, or clear it.
 *
 * `auto` is stored as the absence of the key rather than the string "auto". The stylesheet
 * treats a missing `data-theme` as "follow the OS", and keeping the two representations
 * identical means there is no third way to spell the default that could drift.
 */
export function saveTheme(store: ThemeStore | null | undefined, theme: Theme): void {
  if (!store) return;
  try {
    if (theme === 'auto') store.removeItem(THEME_KEY);
    else store.setItem(THEME_KEY, theme);
  } catch {
    // A tab that cannot persist still switches; it just forgets on reload.
  }
}

/**
 * Put the choice on the root element.
 *
 * `auto` removes the attribute instead of setting `data-theme="auto"`. The stylesheet keys
 * its dark block off `prefers-color-scheme` guarded by `:root:not([data-theme="light"])`,
 * which only resolves correctly when the default state carries no attribute at all.
 */
export function applyTheme(root: { dataset: DOMStringMap }, theme: Theme): void {
  if (theme === 'auto') delete root.dataset['theme'];
  else root.dataset['theme'] = theme;
}
