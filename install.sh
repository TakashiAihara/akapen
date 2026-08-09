#!/bin/sh
# akapen のインストーラ。
#
#   curl -fsSL https://raw.githubusercontent.com/TakashiAihara/akapen/main/install.sh | sh
#
# 環境変数:
#   AKAPEN_VERSION      入れるタグ (既定: latest)
#   AKAPEN_INSTALL_DIR  置き場所 (既定: $HOME/.local/bin)
set -eu

REPO="TakashiAihara/akapen"
VERSION="${AKAPEN_VERSION:-latest}"
INSTALL_DIR="${AKAPEN_INSTALL_DIR:-$HOME/.local/bin}"

die() {
  echo "akapen: $1" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "対応していない OS です: $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "対応していない CPU です: $(uname -m)" ;;
esac

asset="akapen-${os}-${arch}"
if [ "$VERSION" = latest ]; then
  base="https://github.com/${REPO}/releases/latest/download"
else
  base="https://github.com/${REPO}/releases/download/${VERSION}"
fi

command -v curl >/dev/null 2>&1 || die "curl が要ります"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "akapen: ${asset} (${VERSION}) を取得します"
curl -fsSL "${base}/${asset}" -o "${tmp}/akapen" || die "取得に失敗しました: ${base}/${asset}"

# チェックサムは取れた時だけ検証する。SHA256SUMS が無いリリースでも入れられるようにするが、
# 取れたのに一致しない場合は必ず止める (壊れたものを黙って入れない)。
if curl -fsSL "${base}/SHA256SUMS" -o "${tmp}/SHA256SUMS" 2>/dev/null; then
  expected="$(grep " ${asset}\$" "${tmp}/SHA256SUMS" | awk '{print $1}')"
  if [ -n "$expected" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "${tmp}/akapen" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
      actual="$(shasum -a 256 "${tmp}/akapen" | awk '{print $1}')"
    else
      actual=""
      echo "akapen: sha256 を計算する道具が無いので検証を飛ばします" >&2
    fi
    if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
      die "チェックサムが一致しません (期待 ${expected} / 実際 ${actual})"
    fi
    [ -n "$actual" ] && echo "akapen: チェックサム OK"
  fi
else
  echo "akapen: SHA256SUMS が取得できないので検証を飛ばします" >&2
fi

chmod +x "${tmp}/akapen"
mkdir -p "$INSTALL_DIR"
mv "${tmp}/akapen" "${INSTALL_DIR}/akapen"

# 入れたものが動くところまで見る。置いただけで「入りました」と言わない。
"${INSTALL_DIR}/akapen" --help >/dev/null 2>&1 || die "入れたバイナリが動きません: ${INSTALL_DIR}/akapen"

echo "akapen: ${INSTALL_DIR}/akapen に入りました"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "akapen: ${INSTALL_DIR} が PATH にありません。shell の設定に追加してください" >&2 ;;
esac
