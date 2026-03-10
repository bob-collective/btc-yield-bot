#!/usr/bin/env bash
# Build the agentkit packages (sourced via git submodule at vendor/agentkit).
# Skips if both packages are already built.
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENTKIT_TS="$ROOT_DIR/vendor/agentkit/typescript"
CORE_DIR="$AGENTKIT_TS/agentkit"
LANGCHAIN_DIR="$AGENTKIT_TS/framework-extensions/langchain"

if [ ! -d "$CORE_DIR" ]; then
  echo "[agentkit] Submodule not initialised. Run: git submodule update --init"
  exit 1
fi

# Skip if both packages are already built
if [ -d "$CORE_DIR/dist" ] && [ -d "$LANGCHAIN_DIR/dist" ]; then
  exit 0
fi

# Remove agentkit's own pnpm-workspace.yaml to prevent pnpm from
# discovering it as a nested workspace (causes 16-package scope bloat).
rm -f "$AGENTKIT_TS/pnpm-workspace.yaml"

# Build core — install its own deps with pinned TS and opensea-js
if [ ! -d "$CORE_DIR/dist" ]; then
  echo "[agentkit] Building core..."
  cd "$CORE_DIR"
  npm install --ignore-scripts --legacy-peer-deps
  npm install --no-save --force "typescript@5.8.2" "opensea-js@7.1.18"
  # Build bigint-buffer native addon (avoids "Failed to load bindings" warning)
  if [ -d "node_modules/bigint-buffer" ]; then
    cd node_modules/bigint-buffer && npm run rebuild 2>/dev/null || true
    cd "$CORE_DIR"
  fi
  npx tsc
fi

# Build langchain extension
# npm can't handle workspace:* in devDeps, so we temporarily patch it out.
if [ ! -d "$LANGCHAIN_DIR/dist" ]; then
  echo "[agentkit] Building langchain extension..."
  cd "$LANGCHAIN_DIR"

  cp package.json package.json.bak
  node -e "
    const pkg = require('./package.json');
    delete pkg.devDependencies['@coinbase/agentkit'];
    require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));
  "

  npm install --ignore-scripts --legacy-peer-deps
  npm install --no-save --force "typescript@5.8.2"

  mkdir -p node_modules/@coinbase
  ln -sfn "$CORE_DIR" node_modules/@coinbase/agentkit

  npx tsc

  mv package.json.bak package.json
fi

echo "[agentkit] Ready."
