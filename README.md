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

### Sens par défaut

Choisis une fois pour toutes le sens qui correspond à ta façon de tenir la caméra : **↺ -90°**
(anti-horaire, réglage initial), **↻ +90°** (horaire) ou **180°**. Le choix est mémorisé.

### Autre sens, ponctuellement

- **↺ -90°**, **↻ +90°** ou **180°** pour un rush filmé dans un autre sens que d'habitude ;
- **Horizontal d'origine** pour annuler.

Les rotations sont *absolues* : recliquer sur le même bouton ne tourne pas une deuxième fois.

### Sans ouvrir le panneau : le menu

*Fenêtre > Plugins UXP > Rotate* propose aussi :
- **Tourner la sélection en vertical (sens par défaut)**
- **Remettre la sélection à l'horizontale**

Lancées depuis le menu, ces actions sont silencieuses si tout va bien ; une fenêtre s'affiche seulement
en cas de problème.

### Garder le panneau sous la main

Plutôt que de laisser le panneau flottant (une fenêtre flottante réduite est facile à perdre), **ancre-le**
dans l'interface : fais glisser son onglet (le titre « Rotate », pas le bord de la fenêtre) à côté du
panneau Projet jusqu'à voir la zone bleue d'ancrage. Puis *Fenêtre > Espaces de travail > Enregistrer les
modifications* pour qu'il soit toujours là. S'il a disparu : *Fenêtre > Plugins UXP > Rotate*.

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
- Si tu utilises des **proxys**, ils ne sont pas tournés : régénère-les après la rotation.

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
  src/settings.js      préférences (sens de rotation par défaut)
  test/                tests Node + ffmpeg
```
