# Rotate — plugin Premiere Pro

Passe tes rushs filmés à la verticale (Sony A7 III, etc.) **en vertical directement dans Premiere Pro**,
sans ré-export, sans doublon de fichier et sans perte de qualité.

## Comment ça marche

Un fichier MP4/MOV contient, dans son en-tête, une petite **matrice d'affichage** (36 octets) qui dit au
lecteur dans quel sens afficher la vidéo. C'est exactement ce qu'utilisent les smartphones pour leurs
vidéos verticales, et Premiere la respecte.

Le Sony A7 III laisse toujours cette matrice « à l'horizontale ». Le plugin se contente de la réécrire :

- **aucune image n'est ré-encodée** : les données vidéo et audio restent identiques au bit près ;
- **aucun nouveau fichier** : le rush d'origine est modifié sur place (même taille) ;
- **instantané**, même sur un rush 4K de plusieurs Go (seuls 36 octets sont écrits) ;
- **100 % réversible** : le bouton « Horizontal d'origine » remet le fichier exactement à l'identique.

Ensuite le plugin demande à Premiere de relire le média (*Actualiser le média*) : le clip apparaît en
vertical (ex. 2160×3840) dans le chutier, le moniteur source et les nouvelles séquences.

## Installation (mode développement)

Prérequis : **Premiere Pro 25.6 ou plus récent** et l'application **UXP Developer Tool**
(installable depuis Creative Cloud > Applications > Toutes les applications).

1. Dans Premiere : *Paramètres > Plugins* → cocher **Activer le mode développeur**, puis redémarrer Premiere.
2. Ouvrir **UXP Developer Tool** → *Add Plugin* → sélectionner `plugin/manifest.json`.
3. Cliquer sur **Load** (Premiere doit être ouvert).
4. Dans Premiere : *Fenêtre > Plugins UXP > Rotate*.

## Utilisation

1. Dans le panneau **Projet**, sélectionne un ou plusieurs rushs **ou des chutiers entiers**
   (les sous-chutiers sont parcourus aussi).
2. Clique sur **Tourner en vertical** (en haut du panneau, toujours visible) : la rotation se fait
   dans ton **sens par défaut**. Une barre de progression et un bouton **Annuler** s'affichent pendant
   le traitement.

### Aperçu avant validation

Avant d'écrire quoi que ce soit, une fenêtre liste les rushs concernés avec leur sens actuel : ceux à
tourner sont cochés (décoche ceux à ignorer), ceux déjà dans le bon sens et ceux illisibles sont
indiqués. Rien n'est modifié si tu cliques sur *Annuler*. L'aperçu se désactive avec la case
**Aperçu avant de tourner**.

### Sens par défaut

Choisis une fois pour toutes le sens qui correspond à ta façon de tenir la caméra : **↺ -90°**
(anti-horaire, réglage initial), **↻ +90°** (horaire) ou **180°**. Le choix est mémorisé.

### Autre sens, ponctuellement

- **↺ -90°**, **↻ +90°** ou **180°** pour un rush filmé dans un autre sens que d'habitude ;
- **Horizontal d'origine** pour remettre à l'horizontale.

Les rotations sont *absolues* : recliquer sur le même bouton ne tourne pas une deuxième fois.

### Annuler la dernière opération

Le bouton sous *Tourner en vertical* (ex. « Annuler : 12 rush(s) → ↺ -90° (14:32) ») remet les rushs de la
dernière opération exactement comme avant (à l'octet près). Les 10 dernières opérations sont
mémorisées, même après avoir fermé Premiere : on peut cliquer plusieurs fois pour remonter. Un rush
modifié entre-temps par une autre opération n'est pas touché.

### Sans ouvrir le panneau : le menu

*Fenêtre > Plugins UXP > Rotate* propose aussi :
- **Tourner la sélection en vertical (sens par défaut)**
- **Remettre la sélection à l'horizontale**
- **Annuler la dernière opération Rotate**

Lancées depuis le menu, ces actions sont silencieuses si tout va bien ; une fenêtre s'affiche seulement
en cas de problème.

### Raccourci clavier

Premiere ne permet pas encore aux plugins UXP de déclarer des raccourcis clavier (limitation d'Adobe,
indiquée dans leur documentation). Essaie quand même *Modifier > Raccourcis clavier* (ou *Premiere Pro >
Raccourcis clavier* sur Mac) et cherche « Rotate » : si les commandes du menu y apparaissent, tu peux leur
donner la touche de ton choix. Dès qu'Adobe l'autorisera, le plugin proposera un raccourci configurable.

### Garder le panneau sous la main

Plutôt que de laisser le panneau flottant (une fenêtre flottante réduite est facile à perdre), **ancre-le**
dans l'interface : fais glisser son onglet (le titre « Rotate », pas le bord de la fenêtre) à côté du
panneau Projet jusqu'à voir la zone bleue d'ancrage. Puis *Fenêtre > Espaces de travail > Enregistrer les
modifications* pour qu'il soit toujours là. S'il a disparu : *Fenêtre > Plugins UXP > Rotate*.

## Lecture fluide : les proxys verticaux

Un rush 4K « tourné » demande à Premiere de faire pivoter chaque image en temps réel, ce qui peut rendre
la lecture, le déplacement de la tête de lecture et la prévisualisation au survol dans le chutier
saccadés. La solution : des **proxys** légers dont les images sont *réellement* verticales (aucune rotation
à calculer). Premiere les utilise pour le montage, et l'**export utilise toujours les rushs originaux**
en pleine qualité.

### 1. Créer le préréglage (une seule fois, 2 minutes)

Dans **Adobe Media Encoder** :
1. Panneau *Navigateur de préréglages* → bouton **+** → **Créer un préréglage d'encodage**.
2. Nom : `Proxy vertical 1080x1920` · Format : **QuickTime** · Préréglage de base : **Apple ProRes 422 Proxy**.
3. Onglet *Vidéo* : décoche la case de correspondance de la taille d'image, puis **Largeur 1080**,
   **Hauteur 1920** (ou 540 × 960 pour un ordinateur moins puissant). Laisse la cadence « identique à la source ».
4. OK. Puis clic droit sur le préréglage → **Exporter le préréglage…** → enregistre le fichier `.epr`
   où tu veux (ex. dans ton dossier Documents).

### 2. Dans le plugin

1. Section *Proxys verticaux* → **Choisir le préréglage…** → sélectionne le `.epr` exporté.
2. Sélectionne des rushs tournés (ou des chutiers) → **Créer les proxys de la sélection**.
   Ou coche **Créer les proxys après chaque rotation** pour que ce soit automatique.
3. Media Encoder encode en arrière-plan ; chaque proxy est **attaché automatiquement** à son clip dès qu'il
   est terminé (même si tu fermes le panneau entre-temps).
4. Dans le moniteur source/programme, active le bouton **Activer/désactiver les proxys** (ajoute-le via le
   bouton « + » du moniteur s'il n'est pas affiché).

Les proxys sont rangés dans un dossier `Proxies` à côté des rushs (`C0001_Proxy_Vertical.mov`). Ce sont des
fichiers légers, que tu peux supprimer à tout moment sans risque pour tes rushs.

Si tu remets un rush à l'horizontale, son proxy vertical ne correspond plus : désactive les proxys ou
recrée-les.

## Performances

- Le plugin ne lit que quelques centaines d'octets par rush (les en-têtes utiles), quelle que soit la
  durée du clip, et n'écrit que 36 octets.
- Un rush déjà dans le bon sens n'est ni réécrit ni actualisé dans Premiere.
- Chaque fichier n'est actualisé qu'une fois, même s'il apparaît plusieurs fois dans le projet.
- Les actualisations sont faites une par une avec une courte pause, pour que Premiere reste réactif.
- À la fin, le journal affiche le temps passé dans chaque étape (sélection, fichiers, actualisation
  Premiere) : utile pour savoir d'où vient une lenteur.

## À savoir

- Formats gérés : `.mp4`, `.mov`, `.m4v` (le XAVC S du A7 III est du MP4). Les autres sont ignorés.
- Le fichier source est modifié sur place : si tes rushs sont aussi ailleurs (sauvegarde, autre projet),
  ils restent horizontaux là-bas. L'opération étant réversible, ce n'est jamais destructif.
- Les clips **déjà placés dans une séquence** gardent leur cadrage actuel ; la rotation s'applique aux
  nouveaux placements.
- Si un clip ne se met pas à jour dans Premiere : clic droit > **Actualiser le média**.

## Tests

```bash
npm test   # nécessite Node 18+ et ffmpeg/ffprobe
```

Les tests génèrent de vrais MP4/MOV avec ffmpeg, appliquent les rotations et vérifient avec ffprobe que
la rotation est bien lue, que les flux audio/vidéo sont identiques au bit près et que le retour à 0°
redonne un fichier strictement identique à l'original.

## Structure

```
plugin/
  manifest.json        manifeste UXP (Premiere Pro ≥ 25.6)
  index.html, main.js  panneau (UI minimale pour l'instant)
  src/mp4rotation.js   lecture/écriture de la matrice de rotation (indépendant de Premiere)
  src/premiere.js      sélection du panneau Projet, chutiers, rafraîchissement des clips
  src/settings.js      préférences et historique (annulation)
  src/proxies.js       proxys verticaux via Media Encoder, attachement automatique
  test/                tests Node + ffmpeg
```
