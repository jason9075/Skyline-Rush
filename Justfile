set shell := ["sh", "-c"]

# Show available recipes
default:
  @just --list

# Install npm dependencies (--ignore-scripts skips esbuild postinstall on NixOS noexec)
install:
  npm install --ignore-scripts

# Start Vite dev server on :8080, bound to 0.0.0.0 for LAN/phone testing
dev:
  @[ -d node_modules ] || npm install --ignore-scripts
  @echo "\033[36m[drone-control] Starting Vite dev server (LAN-exposed on :8080)...\033[0m"
  node --require ./scripts/fix-noexec.cjs ./node_modules/vite/bin/vite.js --host 0.0.0.0 --port 8080

# Production build → dist/
build:
  @[ -d node_modules ] || npm install --ignore-scripts
  node --require ./scripts/fix-noexec.cjs ./node_modules/vite/bin/vite.js build

# Preview production build on :8080
preview: build
  node --require ./scripts/fix-noexec.cjs ./node_modules/vite/bin/vite.js preview --port 8080

# Remove build artifacts
clean:
  rm -rf dist node_modules
