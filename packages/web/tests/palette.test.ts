/**
 * The palette, measured rather than looked at.
 *
 * Every fault here is silent. A token colour that lands too close to the paper still
 * renders — the code is simply harder to read, on someone else's screen, and nothing
 * says so. The dark values are written twice (once under the media query, once under
 * `[data-theme='dark']`), so a change made in one of them leaves the other behind and
 * the page looks right in whichever half the person editing happened to open.
 *
 * And the rule the whole scheme rests on is a rule about hue: the pen is the only warm
 * colour on the sheet, because that is what tells a reader which marks are a person's.
 * Nothing in the stylesheet enforces it, so it is enforced here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

type Oklch = { l: number; c: number; h: number };

/** The `:root` block, the dark block inside the media query, and the `[data-theme]` one. */
function block(header: string): Map<string, Oklch> {
  const at = css.indexOf(header);
  if (at < 0) throw new Error(`no such block: ${header}`);
  // `\n\s*}`, not `\n}`: the dark block inside the media query closes at an indent, and
  // stopping at the outer brace instead would quietly take in any rule written after it
  const rest = css.slice(at + header.length);
  const end = /\n\s*\}/.exec(rest);
  const body = rest.slice(0, end ? end.index : rest.length);
  const out = new Map<string, Oklch>();
  for (const m of body.matchAll(/(--ak-[\w-]+):\s*oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)/g)) {
    out.set(m[1]!, { l: Number(m[2]) / 100, c: Number(m[3]), h: Number(m[4]) });
  }
  return out;
}

const light = block(':root {');
const darkMedia = block(":root:not([data-theme='light']) {");
const darkAttr = block(":root[data-theme='dark'] {");

/** oklch -> linear sRGB. Clamped, which is what a browser shows for an out-of-gamut colour. */
function linear({ l: L, c: C, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v))) as [number, number, number];
}

function contrast(fg: Oklch, bg: Oklch): number {
  const lum = (c: Oklch) => {
    const [r, g, b] = linear(c);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(fg), lum(bg)].toSorted((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Text drawn on the sheet, and on the band a fence and inline code sit in. */
const INK = [
  '--ak-fg',
  '--ak-fg-2',
  '--ak-fg-muted',
  '--ak-accent',
  '--ak-mark',
  '--ak-warn',
  '--ak-code-keyword',
  '--ak-code-string',
  '--ak-code-number',
  '--ak-code-fn',
  '--ak-code-type',
  '--ak-code-attr',
  '--ak-code-comment',
];

describe.each([
  ['light', light],
  ['dark (media query)', darkMedia],
  ['dark (data-theme)', darkAttr],
])('%s', (_name, tokens) => {
  const get = (k: string): Oklch => {
    const v = tokens.get(k);
    if (!v) throw new Error(`${k} is not defined in this theme`);
    return v;
  };

  /*
   * Every ground text is drawn on, not just the sheet: a row under the pointer, a
   * selected one, the amber band a banner sits in, the bubble that is being read. Text
   * that only clears on the sheet goes unreadable the moment a row is picked.
   */
  const GROUNDS = ['--ak-bg', '--ak-bg-subtle', '--ak-paper-3', '--ak-warn-subtle', '--ak-accent-subtle'];

  it.each(INK)('%s clears 4.5:1 on every ground it can land on', (name) => {
    for (const ground of GROUNDS) {
      expect(contrast(get(name), get(ground)), `${name} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the sheet apart from the desk under it', () => {
    expect(get('--ak-bg').l).toBeGreaterThan(get('--ak-desk').l);
  });

  /*
   * 0-70 is the pen's arc and the amber's. Everything the machine draws itself — the
   * outline's current row, a control under the pointer, a keyword in a fence — has to
   * stay out of it, or the reader can no longer tell a mark from the document.
   */
  it.each([...INK.filter((n) => n.startsWith('--ak-code')), '--ak-mark'])(
    "%s stays out of the pen's hues",
    (name) => {
      /*
       * Hue is an angle, so the pen's arc runs 340-360-70 and not 0-70. Bounding this
       * from below alone lets a red through at 355: the same colour as the pen, on the
       * far side of the wrap, and the reader could no longer tell the two apart.
       */
      const { h } = get(name);
      expect(h).toBeGreaterThan(70);
      expect(h).toBeLessThan(340);
    },
  );

  it('keeps the pen warm', () => {
    expect(get('--ak-accent').h).toBeLessThan(70);
  });
});

it('writes the same dark values in both places', () => {
  expect(Object.fromEntries(darkAttr)).toEqual(Object.fromEntries(darkMedia));
});
