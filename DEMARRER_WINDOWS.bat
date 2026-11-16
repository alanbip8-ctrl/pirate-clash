@echo off
chcp 65001 >nul
cd /d "%~dp0"
title PIRATE CLASH - Serveur multijoueur

echo ==========================================
echo          PIRATE CLASH - DEMARRAGE
echo ==========================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n'est pas installe sur cet ordinateur.
  echo Installe Node.js LTS, puis relance ce fichier.
  start "" "https://nodejs.org/"
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm est introuvable. Reinstalle Node.js LTS en activant npm.
  pause
  exit /b 1
)
if not exist node_modules\ws (
  echo Installation du composant reseau du jeu...
  call npm install
  if errorlevel 1 (
    echo.
    echo Installation echouee. Verifie ta connexion Internet et reessaie.
    pause
    exit /b 1
  )
)
echo.
echo Le serveur va demarrer. Ouvre http://localhost:3000 dans ton navigateur.
start "" "http://localhost:3000"
echo Pour arreter le serveur, ferme cette fenetre ou appuie sur CTRL+C.
echo.
call npm start
if errorlevel 1 (
  echo.
  echo Le serveur n'a pas pu demarrer. Verifie si le port 3000 est deja utilise.
  pause
)
