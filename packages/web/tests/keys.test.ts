/**
 * Key normalisation.
 *
 * The failure being guarded against is silent. `normalizeKey` used to keep whatever
 * order the modifiers were written in, while `keyOf` emitted a fixed one, so a keymap
 * that said `shift+ctrl+k` never fired and said nothing about it. The file's own
 * docstring promised the opposite: "I wrote it but it does nothing" cannot happen.
 *
 * `keyOf` takes a KeyboardEvent but only reads five properties, so these run without a
 * DOM. What matters is that both sides land on the same string.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_KEYMAP, keyOf, mergeKeymap, normalizeKey, unknownModifiers } from '../src/keys.ts';

/** Enough of a KeyboardEvent for keyOf. */
const press = (
  key: string,
  mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {},
): KeyboardEvent =>
  ({
    key,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
  }) as KeyboardEvent;

describe('modifier order', () => {
  it('rewrites every permutation into the same string', () => {
    const written = ['shift+ctrl+k', 'ctrl+shift+k', 'SHIFT+CTRL+K', 'shift + ctrl + k'];
    expect(new Set(written.map(normalizeKey))).toEqual(new Set(['ctrl+shift+k']));
  });

  it('lands on what the event produces, whichever order was written', () => {
    // The bug: this pair used to differ, and the binding was dead.
    expect(normalizeKey('shift+ctrl+k')).toBe(keyOf(press('K', { ctrl: true, shift: true })));
    expect(normalizeKey('alt+meta+enter')).toBe(keyOf(press('Enter', { meta: true, alt: true })));
    expect(normalizeKey('shift+alt+meta+ctrl+x')).toBe(
      keyOf(press('X', { ctrl: true, meta: true, alt: true, shift: true })),
    );
  });

  it('drops a modifier written twice', () => {
    expect(normalizeKey('ctrl+ctrl+k')).toBe('ctrl+k');
  });

  it('keeps the defaults working', () => {
    for (const keys of Object.values(DEFAULT_KEYMAP)) {
      for (const key of keys) expect(normalizeKey(key)).toBe(key);
    }
    expect(keyOf(press('j'))).toBe('j');
    expect(keyOf(press('J', { shift: true }))).toBe('shift+j');
    expect(keyOf(press('Enter', { ctrl: true }))).toBe('ctrl+enter');
    expect(keyOf(press('Escape'))).toBe('escape');
  });
});

describe('base keys', () => {
  it('collapses the arrow spelling, so both forms work', () => {
    expect(normalizeKey('ArrowDown')).toBe('down');
    expect(normalizeKey('down')).toBe('down');
    expect(keyOf(press('ArrowDown'))).toBe('down');
  });

  it('names the space key rather than trimming it away', () => {
    expect(normalizeKey(' ')).toBe('space');
    expect(keyOf(press(' '))).toBe('space');
  });

  it('treats a doubled trailing + as the plus key, not as a missing one', () => {
    // `+` is both the separator and something a person may bind.
    expect(normalizeKey('+')).toBe('+');
    expect(normalizeKey('ctrl++')).toBe('ctrl++');
    expect(keyOf(press('+'))).toBe('+');
    expect(keyOf(press('+', { ctrl: true }))).toBe('ctrl++');
    expect(normalizeKey('ctrl++')).toBe(keyOf(press('+', { ctrl: true })));
  });

  it('does not count shift twice when the character already spells it', () => {
    // On most layouts `+` is shift and another key, so the event carries both `+` and
    // shiftKey. Counting the shift again gives `shift++`, which `ctrl++` cannot match.
    expect(keyOf(press('+', { shift: true }))).toBe('+');
    expect(keyOf(press('+', { ctrl: true, shift: true }))).toBe('ctrl++');
    expect(normalizeKey('ctrl++')).toBe(keyOf(press('+', { ctrl: true, shift: true })));
    expect(keyOf(press('?', { shift: true }))).toBe('?');
  });

  it('still counts shift for a letter, where folding the case would lose it', () => {
    // 'J' becomes 'j', so the modifier is the only thing left saying shift was held.
    expect(keyOf(press('J', { shift: true }))).toBe('shift+j');
    // Space is unchanged by shift, so the modifier is the only way to tell them apart.
    expect(keyOf(press(' ', { shift: true }))).toBe('shift+space');
    expect(keyOf(press('Enter', { shift: true }))).toBe('shift+enter');
  });

  it('leaves a single trailing + as a binding with no key, keeping the modifier', () => {
    // `ctrl+` is malformed either way, but reading it as the plus key would drop the
    // ctrl and hand it a binding that a real `ctrl++` or `+` is entitled to.
    expect(normalizeKey('ctrl+')).toBe('ctrl+');
    expect(normalizeKey('ctrl+')).not.toBe('+');
    expect(normalizeKey('shift+ctrl+')).toBe('ctrl+shift+');
    // Nothing can press it, and it must not shadow the real plus bindings.
    expect(normalizeKey('ctrl+')).not.toBe(keyOf(press('+', { ctrl: true })));
    expect(normalizeKey('ctrl+')).not.toBe(keyOf(press('+')));
  });
});

describe('a modifier that is not one', () => {
  it('is reported by unknownModifiers', () => {
    expect(unknownModifiers('crtl+k')).toEqual(['crtl']);
    expect(unknownModifiers('ctrl+shift+k')).toEqual([]);
  });

  it('is kept in a fixed position, so the result stays deterministic', () => {
    expect(normalizeKey('hyper+ctrl+k')).toBe(normalizeKey('ctrl+hyper+k'));
  });

  it('makes mergeKeymap say so instead of leaving the key dead', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const merged = mergeKeymap(DEFAULT_KEYMAP, { 'row.next': ['crtl+j'] });
      // Kept, not dropped: dropping it would silently fall back to shadowing plain j.
      expect(merged['row.next']).toEqual(['crtl+j']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('crtl+j'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('mergeKeymap', () => {
  it('normalises the override, so order in the file does not matter', () => {
    const merged = mergeKeymap(DEFAULT_KEYMAP, { 'comment.submit': ['shift+ctrl+enter'] });
    expect(merged['comment.submit']).toEqual(['ctrl+shift+enter']);
    expect(merged['comment.submit']?.[0]).toBe(keyOf(press('Enter', { ctrl: true, shift: true })));
  });

  it('accepts a bare string as well as an array', () => {
    expect(mergeKeymap(DEFAULT_KEYMAP, { 'row.next': 'shift+ctrl+n' })['row.next']).toEqual(['ctrl+shift+n']);
  });

  it('drops a binding on null, and leaves the rest of the defaults alone', () => {
    const merged = mergeKeymap(DEFAULT_KEYMAP, { 'lines.toggle': null });
    expect(merged['lines.toggle']).toEqual([]);
    expect(merged['row.next']).toEqual(DEFAULT_KEYMAP['row.next']);
  });

  it('ignores a value it cannot read rather than losing every key', () => {
    expect(mergeKeymap(DEFAULT_KEYMAP, { 'row.next': 42 })['row.next']).toEqual(DEFAULT_KEYMAP['row.next']);
    expect(mergeKeymap(DEFAULT_KEYMAP, null)).toEqual(DEFAULT_KEYMAP);
  });
});
