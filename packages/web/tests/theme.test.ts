/**
 * Light / dark / auto.
 *
 * The failures being guarded against are both silent. Storage throws outright in a
 * private window, and a page that lets that escape renders nothing at all — the reader
 * sees a blank screen and no reason for it. And `auto` has to be the *absence* of both
 * the stored key and the root attribute: the stylesheet resolves the OS preference with
 * `:root:not([data-theme="light"])`, which only works when the default state carries no
 * attribute. Spelling the default as `data-theme="auto"` would render one theme's text
 * on the other theme's ground, and nothing would report it.
 */
import { describe, expect, it } from 'vitest';
import {
  applyTheme,
  nextTheme,
  parseTheme,
  readTheme,
  saveTheme,
  THEME_KEY,
  THEME_ORDER,
  type Theme,
  type ThemeStore,
} from '../src/theme.ts';

/** An in-memory Storage. `fail` makes every method throw, the way a blocked origin does. */
function boom(): never {
  throw new DOMException('denied', 'SecurityError');
}

function store(
  initial: Record<string, string> = {},
  fail = false,
): ThemeStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (fail ? boom() : (data[k] ?? null)),
    setItem: (k, v) => {
      if (fail) boom();
      data[k] = v;
    },
    removeItem: (k) => {
      if (fail) boom();
      delete data[k];
    },
  };
}

/** Enough of an element for applyTheme. */
const root = () => ({ dataset: {} as DOMStringMap });

describe('nextTheme', () => {
  it('walks auto -> light -> dark and back to auto', () => {
    expect(nextTheme('auto')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('auto');
  });

  it('returns to the starting point after one full cycle', () => {
    let t: Theme = 'auto';
    for (let i = 0; i < THEME_ORDER.length; i++) t = nextTheme(t);
    expect(t).toBe('auto');
  });

  it('restarts at auto for a value outside the cycle', () => {
    expect(nextTheme('sepia' as Theme)).toBe('auto');
  });
});

describe('parseTheme', () => {
  it('keeps the two real choices', () => {
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
  });

  it.each([null, undefined, '', 'auto', 'Dark', 'sepia', '{}'])('reads %o as auto', (raw) => {
    expect(parseTheme(raw)).toBe('auto');
  });
});

describe('readTheme', () => {
  it('reads the recorded choice', () => {
    expect(readTheme(store({ [THEME_KEY]: 'dark' }))).toBe('dark');
  });

  it('is auto when nothing was recorded', () => {
    expect(readTheme(store())).toBe('auto');
  });

  it('is auto when there is no storage at all', () => {
    expect(readTheme(null)).toBe('auto');
  });

  it('is auto when reading throws, rather than propagating', () => {
    expect(() => readTheme(store({}, true))).not.toThrow();
    expect(readTheme(store({}, true))).toBe('auto');
  });
});

describe('saveTheme', () => {
  it('writes a real choice', () => {
    const s = store();
    saveTheme(s, 'light');
    expect(s.data[THEME_KEY]).toBe('light');
  });

  it('stores auto as the absence of the key, not the string "auto"', () => {
    const s = store({ [THEME_KEY]: 'dark' });
    saveTheme(s, 'auto');
    expect(THEME_KEY in s.data).toBe(false);
  });

  it('does not throw when the origin refuses to store', () => {
    expect(() => saveTheme(store({}, true), 'dark')).not.toThrow();
    expect(() => saveTheme(store({}, true), 'auto')).not.toThrow();
  });

  it('does nothing when there is no storage at all', () => {
    expect(() => saveTheme(null, 'dark')).not.toThrow();
  });
});

describe('applyTheme', () => {
  it('stamps a real choice on the root', () => {
    const r = root();
    applyTheme(r, 'dark');
    expect(r.dataset['theme']).toBe('dark');
  });

  it('removes the attribute for auto instead of writing "auto"', () => {
    const r = root();
    applyTheme(r, 'light');
    applyTheme(r, 'auto');
    expect('theme' in r.dataset).toBe(false);
  });

  it('never leaves the previous choice behind when switching', () => {
    const r = root();
    applyTheme(r, 'light');
    applyTheme(r, 'dark');
    expect(r.dataset['theme']).toBe('dark');
  });
});

describe('the three parts agree', () => {
  it('a full cycle leaves storage and the root back where they started', () => {
    const s = store();
    const r = root();
    let t: Theme = readTheme(s);
    for (let i = 0; i < THEME_ORDER.length; i++) {
      t = nextTheme(t);
      applyTheme(r, t);
      saveTheme(s, t);
    }
    expect(t).toBe('auto');
    expect(THEME_KEY in s.data).toBe(false);
    expect('theme' in r.dataset).toBe(false);
  });

  it('survives a reload: what was saved is what comes back', () => {
    const s = store();
    saveTheme(s, 'dark');
    expect(readTheme(s)).toBe('dark');
  });
});
