#!/bin/bash
set -euo pipefail
# Install dependencies for Claude Code on the web sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi
cd "$CLAUDE_PROJECT_DIR"
# Electron's postinstall downloads a ~100 MB platform binary that web-session
# containers can't fetch (proxy 403) and never need — sessions verify code,
# they don't launch the Electron shell.
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
npm install --no-audit --no-fund
