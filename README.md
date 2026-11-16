# PIRATE CLASH — édition multijoueur

## Démarrer le jeu (sans taper de commandes)

### Windows
1. Décompresse le ZIP dans un dossier.
2. Installe Node.js LTS si ce n'est pas déjà fait : https://nodejs.org/
3. Double-clique sur `DEMARRER_WINDOWS.bat`.
4. Le jeu s'ouvre sur `http://localhost:3000`.

### Mac / Linux
1. Décompresse le ZIP.
2. Installe Node.js LTS : https://nodejs.org/
3. Ouvre `DEMARRER_MAC_LINUX.command` (sur Mac, autorise son ouverture si le système le demande).
4. Le jeu s'ouvre sur `http://localhost:3000`.

**Important :** n'ouvre pas `index.html` en double-cliquant dessus pour jouer en ligne. Le fichier HTML seul ne peut pas créer le serveur de matchmaking.

## Multijoueur
- **Joueur aléatoire** : place le joueur dans une file et l'associe au prochain joueur disponible sur cette même instance.
- **Défier un ami** : sélectionne un joueur en ligne puis clique sur `DÉFIER`.
- **Salon privé** : crée un code à six caractères et partage-le à ton ami.

Pour jouer à distance, héberge tout ce dossier sur un serveur Node.js qui prend en charge les WebSockets, puis partage la même adresse à tes amis. Une seule instance serveur doit gérer la file d'attente.

## État du serveur
Ouvre `/health` à la suite de l'adresse du serveur pour consulter le nombre de connexions, de joueurs en combat et en attente.

## Personnages
La sélection et les combattants utilisent le moteur pixel-art du jeu, avec des silhouettes, coiffures, accessoires et détails distinctifs propres à chaque personnage.
