/**
 * The keymap lives in this one file.
 *
 * Spread it around and nobody can tell which keys are free, which makes the
 * revisit we already plan impossible. app.ts implements the actions (`row.next`
 * and friends); the key bindings belong here.
 *
 * The defaults are provisional. `--keymap <file>` overrides them.
 */

/** Default keys per action. An action may have several keys. */
/** action name → keys */
export type Keymap = Record<string, string[]>;

export const DEFAULT_KEYMAP: Keymap = {
  'row.next': ['j'],
  'row.prev': ['k'],
  // The keyboard can select a range the same way a mouse drag does.
  // If only one of them can, the two paths diverge.
  'row.extendNext': ['shift+j'],
  'row.extendPrev': ['shift+k'],
  'comment.start': ['c'],
  'comment.submit': ['ctrl+enter', 'meta+enter'],
  'comment.cancel': ['escape'],
  'lines.toggle': ['l'],
};

// Arrow keys are not bound by default. Taking them breaks page scrolling, which
// breaks reading. Add them with --keymap if you want them (examples/keymap.json).
// Enter is left out for the same kind of reason: it means something else while a
// bubble holds DOM focus.

/**
 * Actions that still fire while typing in a textarea or input.
 * Anything else must let the keystroke become text, so it stays inert.
 */
const WHILE_TYPING = new Set(['comment.submit', 'comment.cancel']);

/**
 * The one order modifiers are written in. Everything is rewritten into it, so the
 * order someone typed never has to match the order a KeyboardEvent produces.
 */
const MODIFIERS = ['ctrl', 'meta', 'alt', 'shift'] as const;

const isModifier = (part: string): part is (typeof MODIFIERS)[number] =>
  (MODIFIERS as readonly string[]).includes(part);

/** Modifier names in a binding that are not modifiers. Only a typo can produce one. */
export function unknownModifiers(name: string): string[] {
  const parts = splitKey(String(name).toLowerCase());
  return [...new Set(parts.modifiers.filter((p) => !isModifier(p)))];
}

/**
 * Split a written key into its modifiers and its base.
 *
 * `+` is both the separator and a key someone may bind. The base is `+` only when the
 * separator before it is there too: `ctrl++` is ctrl plus the plus key. A single
 * trailing `+` as in `ctrl+` is a binding with no key, and it stays that way — reading
 * it as the plus key would drop the ctrl and quietly take over a real `+` binding.
 */
function splitKey(lower: string): { modifiers: string[]; base: string } {
  const parts = lower.split('+');
  let base = parts.pop() ?? '';
  if (base === '' && parts[parts.length - 1] === '') {
    base = '+';
    parts.pop();
  }
  // trim would eat the space key, so catch it first
  base = base === ' ' ? 'space' : base.trim();
  if (base.startsWith('arrow')) base = base.slice(5);
  return { modifiers: parts.map((p) => p.trim()).filter((p) => p !== ''), base };
}

/**
 * Normalise a key name. Both the config file and KeyboardEvent go through here, so
 * "I wrote it but it does nothing" cannot happen.
 *
 * Modifiers are rewritten into one fixed order and de-duplicated. Without that, only
 * the half of the promise above that concerns spelling held: `shift+ctrl+k` in a config
 * stayed `shift+ctrl+k` while the event produced `ctrl+shift+k`, and the binding never
 * fired — with nothing said about it.
 *
 * KeyboardEvent.key reports arrows as `ArrowDown`, but making people write
 * `arrowdown` in config is noise, so it collapses to `down`. Both spellings work.
 *
 * A modifier that is not one of the four is kept, in a fixed position, so that the
 * result is still deterministic. Such a binding cannot fire — no event produces it —
 * which is why mergeKeymap says so rather than leaving it silent.
 */
export function normalizeKey(name: string): string {
  const { modifiers, base } = splitKey(String(name).toLowerCase());
  const known = MODIFIERS.filter((m) => modifiers.includes(m));
  const rest = [...new Set(modifiers.filter((p) => !isModifier(p)))].toSorted();
  return [...known, ...rest, base].join('+');
}

/** KeyboardEvent → `ctrl+shift+k`. The same normalisation the config goes through. */
export function keyOf(e: KeyboardEvent): string {
  const parts = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.metaKey) parts.push('meta');
  if (e.altKey) parts.push('alt');
  // shift uppercases letters, so normalise it as a modifier and land on 'shift+j'
  if (e.shiftKey) parts.push('shift');
  parts.push(e.key);
  return normalizeKey(parts.join('+'));
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)
  );
}

/**
 * Merge the override JSON. Same shape as the defaults: `{ action: [key] }`.
 * Writing `null` or `[]` drops a default binding — without a way to disable one
 * you get stuck.
 */
export function mergeKeymap(base: Keymap, override: unknown): Keymap {
  const merged: Keymap = { ...base };
  if (!override || typeof override !== 'object') return merged;
  for (const [action, keys] of Object.entries(override)) {
    if (keys === null) {
      merged[action] = [];
    } else if (Array.isArray(keys)) {
      merged[action] = keys.filter((k) => typeof k === 'string').map(normalizeKey);
    } else if (typeof keys === 'string') {
      merged[action] = [normalizeKey(keys)];
    }
    // Ignore anything else (numbers, objects). Staying on the defaults beats a broken config killing every key.

    // Ordering is handled, but a misspelled modifier still cannot match any event. The
    // binding is kept — dropping it would shadow the plain key — and said out loud,
    // because a key that does nothing with no explanation is the whole complaint.
    for (const key of merged[action] ?? []) {
      const unknown = unknownModifiers(key);
      if (unknown.length > 0) {
        console.warn(`akapen: ${action} is bound to "${key}", which no key press can produce`);
      }
    }
  }
  return merged;
}

/** key → action. Not last-wins: the action defined first keeps the key. */
function invert(keymap: Keymap): Map<string, string> {
  const index = new Map<string, string>();
  for (const [action, keys] of Object.entries(keymap)) {
    for (const key of keys ?? []) {
      const k = normalizeKey(key);
      if (!index.has(k)) index.set(k, action);
    }
  }
  return index;
}

/**
 * @param keymap  the result of mergeKeymap
 * @param actions action name → handler. Returning false leaves the browser default alone.
 */
export function bindKeys(
  keymap: Keymap,
  actions: Record<string, (e: KeyboardEvent) => unknown>,
): Map<string, string> {
  const index = invert(keymap);
  document.addEventListener('keydown', (e) => {
    // Keys during IME composition drive the conversion, not akapen. Letting them
    // through means Escape, meant to cancel the conversion, discards the draft too.
    // keyCode 229 is the fallback for environments that do not set isComposing.
    if (e.isComposing || e.keyCode === 229) return;
    const action = index.get(keyOf(e));
    if (!action) return;
    if (isTyping(e.target) && !WHILE_TYPING.has(action)) return;
    const fn = actions[action];
    if (!fn) return;
    if (fn(e) === false) return;
    e.preventDefault();
  });
  return index;
}

export async function loadKeymap(): Promise<Keymap> {
  try {
    const res = await fetch('/keymap.json');
    if (!res.ok) return { ...DEFAULT_KEYMAP };
    return mergeKeymap(DEFAULT_KEYMAP, await res.json());
  } catch {
    // An unreadable config must not make the tool unusable
    return { ...DEFAULT_KEYMAP };
  }
}
