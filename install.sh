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

# 検証できない場合は止める。curl | sh で流し込む導線なので、fail-open は素通りと同義になる。
# 「SHA256SUMS の無いリリースでも入れられるように」は、未検証の実行ファイルを配る理由にならない。
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  die "sha256sum も shasum も見つかりません。検証できないので中止します"
fi

curl -fsSL "${base}/SHA256SUMS" -o "${tmp}/SHA256SUMS" \
  || die "SHA256SUMS が取得できません: ${base}/SHA256SUMS"

expected="$(grep " ${asset}$" "${tmp}/SHA256SUMS" | awk '{print $1}')"
[ -n "$expected" ] || die "SHA256SUMS に ${asset} の行がありません"

actual="$(sha256 "${tmp}/akapen")"
[ "$actual" = "$expected" ] || die "チェックサムが一致しません (期待 ${expected} / 実際 ${actual})"
echo "akapen: チェックサム OK"

# 注意: この checksum は Release と同じ場所から取っているので、改竄されれば両方差し替えられる。
# 真正性まで見るなら gh が要る (任意):
#   gh attestation verify <binary> --repo TakashiAihara/akapen \
#     --signer-workflow TakashiAihara/akapen/.github/workflows/release.yml
#
# --repo だけだと同じ repository の別 workflow が作った attestation でも通るので、
# 署名元の workflow まで固定する。
if command -v gh >/dev/null 2>&1 && [ "${AKAPEN_VERIFY_ATTESTATION:-0}" = 1 ]; then
  gh attestation verify "${tmp}/akapen" \
    --repo "$REPO" \
    --signer-workflow "${REPO}/.github/workflows/release.yml" >/dev/null 2>&1 \
    && echo "akapen: attestation OK" \
    || die "attestation の検証に失敗しました"
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
