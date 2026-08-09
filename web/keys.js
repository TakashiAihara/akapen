/**
 * キーマップはこの 1 ファイルに集約する。
 *
 * 散らすと「何のキーが空いているか」が誰にも分からなくなり、割り当ての見直し (この先やる前提)
 * ができなくなる。app.js 側は動作名 (`row.next` 等) を実装するだけで、キーとの対応はここが持つ。
 *
 * 既定値は暫定。`--keymap <file>` の JSON で上書きできる。
 */

/** 動作名 → 既定のキー。1 つの動作に複数のキーを割り当ててよい。 */
export const DEFAULT_KEYMAP = {
  'row.next': ['j'],
  'row.prev': ['k'],
  // マウスのドラッグと同じ範囲選択をキーボードでも取れるようにする。
  // 片方でしか範囲が作れないと、動線が 2 本に割れる
  'row.extendNext': ['shift+j'],
  'row.extendPrev': ['shift+k'],
  'comment.start': ['c'],
  'comment.submit': ['ctrl+enter', 'meta+enter'],
  'comment.cancel': ['escape'],
  'lines.toggle': ['l'],
};

// 矢印キーは既定に入れない。奪うとページのスクロールが効かなくなり、読む方が壊れる。
// 欲しい人は --keymap で足せる (examples/keymap.json)。同じ理由で Enter も入れていない
// (吹き出しに DOM フォーカスがある時に別の意味を持つため)。

/**
 * 入力中 (textarea / input) でも効かせる動作。
 * ここに無いものは打鍵がそのまま本文になるべきなので、入力中は動かさない。
 */
const WHILE_TYPING = new Set(['comment.submit', 'comment.cancel']);

/**
 * キー名を正規化する。設定ファイル側と KeyboardEvent 側の両方をここに通し、
 * 「書いたのに効かない」を作らない。
 *
 * KeyboardEvent.key は矢印を `ArrowDown` で返すが、設定に `arrowdown` と書かせるのは
 * 冗長なので `down` に寄せる。両方の綴りを受け付ける。
 */
export function normalizeKey(name) {
  const parts = String(name).toLowerCase().split('+');
  let base = parts.pop() ?? '';
  // 空白キーは trim で消えるので、先に拾う
  base = base === ' ' ? 'space' : base.trim();
  if (base.startsWith('arrow')) base = base.slice(5);
  return [...parts.map((p) => p.trim()), base].join('+');
}

/** KeyboardEvent → `ctrl+shift+k` 形式。修飾子の順序を固定して表記のブレを潰す。 */
export function keyOf(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.metaKey) parts.push('meta');
  if (e.altKey) parts.push('alt');
  // 英字は shift で大文字になるので、修飾子として正規化して 'shift+j' に寄せる
  if (e.shiftKey) parts.push('shift');
  parts.push(normalizeKey(e.key));
  return parts.join('+');
}

function isTyping(target) {
  return target instanceof HTMLElement && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
}

/**
 * 上書き用 JSON をマージする。形は既定値と同じ `{ 動作名: [キー] }`。
 * 値に `null` / `[]` を書くと既定の割り当てを外せる (無効化する手段が無いと詰む)。
 */
export function mergeKeymap(base, override) {
  const merged = { ...base };
  if (!override || typeof override !== 'object') return merged;
  for (const [action, keys] of Object.entries(override)) {
    if (keys === null) {
      merged[action] = [];
    } else if (Array.isArray(keys)) {
      merged[action] = keys.filter((k) => typeof k === 'string').map(normalizeKey);
    } else if (typeof keys === 'string') {
      merged[action] = [normalizeKey(keys)];
    }
    // 上記以外 (数値・オブジェクト等) は無視する。壊れた設定でキーが全部死ぬより既定に留まる方がまし
  }
  return merged;
}

/** キー → 動作名 の逆引き。後勝ちにせず、先に定義された動作を優先する。 */
function invert(keymap) {
  const index = new Map();
  for (const [action, keys] of Object.entries(keymap)) {
    for (const key of keys ?? []) {
      const k = normalizeKey(key);
      if (!index.has(k)) index.set(k, action);
    }
  }
  return index;
}

/**
 * @param keymap  mergeKeymap の結果
 * @param actions 動作名 → 関数。戻り値が false なら既定動作を止めない
 */
export function bindKeys(keymap, actions) {
  const index = invert(keymap);
  document.addEventListener('keydown', (e) => {
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

export async function loadKeymap() {
  try {
    const res = await fetch('/keymap.json');
    if (!res.ok) return { ...DEFAULT_KEYMAP };
    return mergeKeymap(DEFAULT_KEYMAP, await res.json());
  } catch {
    // 設定が読めないだけで操作不能にはしない
    return { ...DEFAULT_KEYMAP };
  }
}
