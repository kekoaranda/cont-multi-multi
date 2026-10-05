#!/bin/bash
# Instala las dependencias de npm al iniciar una sesión de Claude Code en la nube,
# para que `npm test` y `npm run dev` funcionen de entrada.
set -euo pipefail

# Solo en la nube; en una computadora local no hace nada.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# El repo no versiona package-lock.json: no lo generamos para no dejar
# un archivo nuevo sin seguimiento en cada sesión.
npm install --no-package-lock --no-audit --no-fund
