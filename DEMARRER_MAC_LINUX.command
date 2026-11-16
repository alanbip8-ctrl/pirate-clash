#!/bin/bash
cd "$(dirname "$0")"
echo "=========================================="
echo "       PIRATE CLASH - DEMARRAGE"
echo "=========================================="
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js LTS est requis. Installe-le depuis https://nodejs.org/ puis relance ce fichier."
  read -r -p "Appuie sur Entree pour fermer..."
  exit 1
fi
if [ ! -d node_modules/ws ]; then
  npm install || { echo "Installation echouee."; read -r; exit 1; }
fi
(open http://localhost:3000 >/dev/null 2>&1 || xdg-open http://localhost:3000 >/dev/null 2>&1 || true)
npm start
