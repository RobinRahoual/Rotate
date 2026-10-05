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
2. Clique sur **Tourner en vertical** : la rotation se fait dans ton **sens par défaut**.

### Sens par défaut

Sous le bouton principal, choisis une fois pour toutes le sens qui correspond à ta façon de tenir la
caméra : **↺ -90°** (anti-horaire, réglage initial), **↻ +90°** (horaire) ou **180°**. Le choix est
mémorisé : il est conservé quand tu fermes le panneau ou Premiere.

### Autres actions

Les boutons du bas servent ponctuellement :
- **↺ -90°**, **↻ +90°** ou **180°** pour un rush filmé dans un autre sens que d'habitude ;
- **Horizontal d'origine** pour annuler.

Les rotations sont *absolues* : recliquer sur le même bouton ne tourne pas une deuxième fois.

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
