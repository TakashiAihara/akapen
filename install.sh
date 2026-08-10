#!/bin/sh
# akapen installer.
#
#   curl -fsSL https://raw.githubusercontent.com/TakashiAihara/akapen/main/install.sh | sh
#
# Environment:
#   AKAPEN_VERSION      tag to install (default: latest)
#   AKAPEN_INSTALL_DIR  where to put it (default: $HOME/.local/bin)
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
  *) die "unsupported OS: $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac

asset="akapen-${os}-${arch}"
if [ "$VERSION" = latest ]; then
  base="https://github.com/${REPO}/releases/latest/download"
else
  base="https://github.com/${REPO}/releases/download/${VERSION}"
fi

command -v curl >/dev/null 2>&1 || die "curl is required"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "akapen: fetching ${asset} (${VERSION})"
curl -fsSL "${base}/${asset}" -o "${tmp}/akapen" || die "download failed: ${base}/${asset}"

# Stop when verification cannot happen. This is piped into sh, so failing open is the
# same as no check at all. "so releases without SHA256SUMS still install" is not a reason
# to hand someone an unverified executable.
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  die "neither sha256sum nor shasum found; cannot verify, aborting"
fi

curl -fsSL "${base}/SHA256SUMS" -o "${tmp}/SHA256SUMS" \
  || die "could not fetch SHA256SUMS: ${base}/SHA256SUMS"

expected="$(grep " ${asset}$" "${tmp}/SHA256SUMS" | awk '{print $1}')"
[ -n "$expected" ] || die "SHA256SUMS has no line for ${asset}"

actual="$(sha256 "${tmp}/akapen")"
[ "$actual" = "$expected" ] || die "checksum mismatch (expected ${expected}, got ${actual})"
echo "akapen: checksum ok"

# Note: this checksum comes from the same release, so anyone able to tamper with one can
# replace both. Verifying authenticity needs gh (optional):
#   gh attestation verify <binary> --repo TakashiAihara/akapen \
#     --signer-workflow TakashiAihara/akapen/.github/workflows/release.yml
#
# With --repo alone an attestation from any workflow in the repo passes, so pin the
# workflow that signed it.
if command -v gh >/dev/null 2>&1 && [ "${AKAPEN_VERIFY_ATTESTATION:-0}" = 1 ]; then
  # A && B || C is not if-then-else: a failing echo alone would reach die (SC2015)
  if gh attestation verify "${tmp}/akapen" \
    --repo "$REPO" \
    --signer-workflow "${REPO}/.github/workflows/release.yml" >/dev/null 2>&1; then
    echo "akapen: attestation ok"
  else
    die "attestation verification failed"
  fi
fi

chmod +x "${tmp}/akapen"
mkdir -p "$INSTALL_DIR"
mv "${tmp}/akapen" "${INSTALL_DIR}/akapen"

# Check that what we installed actually runs. Placing a file is not installing it.
"${INSTALL_DIR}/akapen" --help >/dev/null 2>&1 || die "the installed binary does not run: ${INSTALL_DIR}/akapen"

echo "akapen: installed to ${INSTALL_DIR}/akapen"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "akapen: ${INSTALL_DIR} is not on PATH; add it in your shell config" >&2 ;;
esac
