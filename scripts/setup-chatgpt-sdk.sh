#!/usr/bin/env bash
# Sets up the official OpenAI "Sign in with ChatGPT Devkit" locally so the
# app's ChatGPT sign-in adapter can resolve @siwc/local.
#
# The devkit is distributed under its own Sign In with ChatGPT Devkit
# Noncommercial License (see .siwc-devkit/LICENSE after this script runs,
# and patches/README.md). It is NOT committed to this repository; this
# script clones it, applies a small local patch, and builds it.
set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DEST"

DEVKIT_DIR=".siwc-devkit"
DEVKIT_REPO="https://github.com/openai/sign-in-with-chatgpt-devkit.git"
DEVKIT_COMMIT="0a36fefeb913055c8c7a1a29b63d82b96b2e841a"
PATCH_FILE="$DEST/patches/siwc-local-image-data-url.patch"

echo "=== ChatGPT sign-in SDK setup ==="

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required." >&2
  exit 1
fi

if [[ -d "$DEVKIT_DIR/.git" ]]; then
  echo "Devkit already present at $DEVKIT_DIR, skipping clone."
else
  echo "Cloning $DEVKIT_REPO at $DEVKIT_COMMIT ..."
  git clone "$DEVKIT_REPO" "$DEVKIT_DIR"
  (cd "$DEVKIT_DIR" && git checkout "$DEVKIT_COMMIT")
fi

cd "$DEVKIT_DIR"
CURRENT_COMMIT="$(git rev-parse HEAD)"
if [[ "$CURRENT_COMMIT" != "$DEVKIT_COMMIT" ]]; then
  echo "WARNING: $DEVKIT_DIR is at $CURRENT_COMMIT, not the pinned $DEVKIT_COMMIT." >&2
  echo "Continuing, but the patch may not apply cleanly." >&2
fi

echo "Applying local patch (idempotent) ..."
if git apply --reverse --check "$PATCH_FILE" >/dev/null 2>&1; then
  echo "Patch already applied, skipping."
elif git apply --check "$PATCH_FILE" >/dev/null 2>&1; then
  git apply "$PATCH_FILE"
  echo "Patch applied."
else
  echo "Error: patch does not apply cleanly to the current devkit checkout." >&2
  echo "See $PATCH_FILE and patches/README.md." >&2
  exit 1
fi

echo "Installing devkit dependencies ..."
npm install

echo "Building @siwc/local (devkit's own documented build command) ..."
npm run build -w @siwc/local

cd "$DEST"

echo "Linking node_modules/@siwc/local -> $DEVKIT_DIR/packages/local ..."
mkdir -p node_modules/@siwc
if [[ -L node_modules/@siwc/local ]]; then
  rm node_modules/@siwc/local
fi
if [[ -e node_modules/@siwc/local ]]; then
  echo "Error: node_modules/@siwc/local exists and is not a symlink. Remove it and re-run." >&2
  exit 1
fi
ln -s "$DEST/$DEVKIT_DIR/packages/local" node_modules/@siwc/local

if [[ ! -f node_modules/@siwc/local/dist/index.js ]]; then
  echo "Error: build did not produce dist/index.js." >&2
  exit 1
fi

echo "Done. node_modules/@siwc/local -> $DEVKIT_DIR/packages/local (built)."
echo "Note: 'npm install' at the project root can remove this symlink; re-run this script if so."
