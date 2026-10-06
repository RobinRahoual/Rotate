# Rotate — plugin Premiere Pro

Plugin gratuit créé par **Robin Rahoual** — suis-moi sur Instagram : [@robin.rahoual](https://www.instagram.com/robin.rahoual/).

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

## Installation

### Installation durable (recommandée)

1. Récupère le fichier `Rotate-<version>.ccx` (ou fabrique-le : `npm run package` → dossier `dist/`).
2. **Double-clique** dessus : l'application Creative Cloud s'ouvre et l'installe (elle prévient que le
   plugin ne vient pas de la Marketplace : clique sur *Installer*).
3. Dans Premiere : *Fenêtre > Plugins UXP > Rotate*.

Le plugin reste installé après un redémarrage ou une mise à jour de Premiere. Pour le désinstaller :
application Creative Cloud > *Gérer les plugins*. Si tu utilisais la version de développement, décharge-la
d'abord dans UXP Developer Tool (sinon les deux se mélangent).

## Utilisation

1. Dans le panneau **Projet**, sélectionne un ou plusieurs rushs **ou des chutiers entiers**
   (les sous-chutiers sont parcourus aussi).
2. Clique sur **Tourner en vertical** (en haut du panneau, toujours visible) : la rotation se fait
   dans ton **sens par défaut**.

### Suivi de l'opération

Pendant le traitement, le bloc d'état en haut du panneau montre que ça tourne (icône animée et temps
écoulé), l'étape en cours (analyse de la sélection, lecture des rushs, rotation), où on en est
(« 3/12 · C0003.MP4 »), une barre de progression et le temps restant estimé. Le bouton **Arrêter**
interrompt proprement après le rush en cours.

À la fin, le bloc indique le résultat : **✓ vert** si tout s'est bien passé, **⚠ orange** s'il y a eu des
problèmes sur certains rushs, **✕ rouge** en cas d'échec, avec **Voir le détail** pour aller au journal.
Les proxys en cours dans Media Encoder ont leur propre suivi (« Proxys : 2/5 prêts »).


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

Lancées depuis le menu, ces actions ouvrent le panneau Rotate pour que tu suives leur avancement.

### Raccourcis clavier

Quand le panneau Rotate est sélectionné (clique dedans), une touche suffit :

| Touche | Action |
| --- | --- |
| **V** | Tourner la sélection (sens par défaut) |
| **H** | Remettre à l'horizontale |
| **U** | Annuler la dernière opération |
| **P** | Créer les proxys de la sélection |
| **Échap** | Arrêter l'opération en cours |

Pour changer une touche : section *Raccourcis clavier*, clique sur la touche puis appuie sur la nouvelle
(lettre ou chiffre ; Retour arrière pour n'en mettre aucune). Une touche ne sert qu'à une action.

Premiere ne permet pas encore aux plugins de déclarer des raccourcis **globaux** (actifs partout). Essaie
quand même *Modifier > Raccourcis clavier* et cherche « Rotate » : si les commandes du menu y apparaissent,
tu peux leur donner un raccourci global.

### Signal de fin

Quand une opération dure plus de 8 secondes, ou quand un lot de proxys est prêt, le panneau passe au
premier plan, le bilan clignote et un petit son est joué (désactivable : *Jouer un son à la fin*).
*Tester le signal* permet de l'essayer.

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

### Utilisation

1. Sélectionne des rushs tournés (ou des chutiers) → **Créer les proxys de la sélection**.
   Ou coche **Créer les proxys après chaque rotation** pour que ce soit automatique.
2. La toute première fois, le plugin **prépare lui-même le préréglage Media Encoder** (environ 30 s) :
   il part du préréglage « Apple ProRes 422 Proxy » installé avec Media Encoder, le passe en vertical à la
   taille choisie (720×1280 par défaut ; 540×960 ou 1080×1920 au choix), en gardant la cadence de la
   source, puis le **vérifie par un encodage test d'une seconde**. Il est ensuite réutilisé.
3. Media Encoder encode en arrière-plan ; chaque proxy est **vérifié** (vertical, même format et même
   cadence que le rush) puis **attaché automatiquement** à son clip (même si tu fermes le panneau
   entre-temps).
4. Dans le moniteur source/programme, active le bouton **Activer/désactiver les proxys** (ajoute-le via le
   bouton « + » du moniteur s'il n'est pas affiché).

Media Encoder doit être installé (il l'est avec Creative Cloud quand Premiere l'est, sinon : application
Creative Cloud > Media Encoder > Installer).

### En secours : préréglage manuel

Si la préparation automatique échoue, crée le préréglage dans Media Encoder : *Navigateur de préréglages*
→ **+** → **Créer un préréglage d'encodage** · Format **QuickTime** · base **Apple ProRes 422 Proxy** ·
onglet *Vidéo* : décoche « identique à la source » pour la taille, mets **720 × 1280**, laisse la cadence
identique à la source · OK · clic droit → **Exporter le préréglage…**. Puis dans le plugin :
**Choisir un préréglage manuel…** (et **Revenir à l'automatique** pour annuler ce choix).

Les proxys sont rangés dans un dossier `Proxies` à côté des rushs (`C0001_Proxy_Vertical.mov`). Ce sont des
fichiers légers, que tu peux supprimer à tout moment sans risque pour tes rushs.

### Nettoyer les proxys

**Analyser et nettoyer les proxys** affiche la place occupée par les proxys Rotate et liste ceux qui ne sont
attachés à aucun clip du projet ouvert (anciennes versions, rushs retirés du projet…). Tu coches ceux à
supprimer ; ceux qui sont utilisés ou en cours d'encodage ne sont jamais proposés. Attention : un proxy
inutilisé dans ce projet peut servir dans un autre projet (il faudrait alors le recréer).

Si tu remets un rush à l'horizontale, son proxy vertical ne correspond plus : désactive les proxys ou
recrée-les.

## Mises à jour de Premiere

Le cœur du plugin (la rotation) ne dépend pas de Premiere : il modifie une donnée standard du format
MP4/MOV. Le plugin n'a pas de version maximale et continue de se charger dans les versions suivantes
de Premiere. Au démarrage, il vérifie que les fonctions de Premiere dont il a besoin existent toujours
et affiche « Plugin à mettre à jour » dans le cas contraire, plutôt que d'échouer en pleine rotation.
Le préréglage des proxys est recréé automatiquement s'il ne fonctionne plus.

## Performances

- Le plugin ne lit que les en-têtes utiles de chaque rush, par blocs de 4 Ko : environ 6 lectures disque
  par rush, quelle que soit sa durée, et seulement 36 octets écrits.
- Chaque rush n'est ouvert qu'une fois en écriture (vérification et écriture sur le même accès) ; un rush
  déjà dans le bon sens n'est ni réécrit ni actualisé dans Premiere.
- Chaque fichier n'est actualisé qu'une fois, même s'il apparaît plusieurs fois dans le projet.
- Les actualisations sont faites une par une, avec une pause proportionnelle au temps que Premiere a mis
  pour la précédente (entre 30 et 250 ms), pour que Premiere reste réactif.
- Au-delà de 150 rushs, l'aperçu n'affiche que les 150 premiers (les autres sont inclus d'office) pour
  s'ouvrir instantanément.
- Le suivi des proxys ne relit un fichier que lorsqu'il a fini de grossir, et ne reparcourt le projet
  qu'une fois par minute au plus si un rush est introuvable.
- L'historique d'annulation est plafonné (10 opérations, ~1 Mo) et n'est relu que lorsqu'il change.
- À la fin, le journal affiche le temps passé dans chaque étape (sélection, fichiers, actualisation
  Premiere) : utile pour savoir d'où vient une lenteur.

## Sécurité des rushs

- Rush sur une carte SD verrouillée ou un disque protégé : message clair, rien n'est modifié.
- Rush verrouillé par Premiere (Windows) : le clip est mis hors ligne le temps de l'écriture, puis **toujours**
  re-lié, même si l'écriture échoue.
- Annulation : un rush modifié entre-temps par une autre opération n'est pas touché.

## À savoir

- Formats gérés : `.mp4`, `.mov`, `.m4v` (le XAVC S du A7 III est du MP4). Les autres sont ignorés.
- Le fichier source est modifié sur place : si tes rushs sont aussi ailleurs (sauvegarde, autre projet),
  ils restent horizontaux là-bas. L'opération étant réversible, ce n'est jamais destructif.
- Les clips **déjà placés dans une séquence** gardent leur cadrage actuel ; la rotation s'applique aux
  nouveaux placements.
- Si un clip ne se met pas à jour dans Premiere : clic droit > **Actualiser le média**.

## Tests

```bash
npm test          # nécessite Node 18+ et ffmpeg/ffprobe
npm run package   # fabrique dist/Rotate-<version>.ccx
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
  src/proxies.js       proxys verticaux via Media Encoder, vérification et attachement automatique
  src/presets.js       création et vérification automatiques du préréglage Media Encoder vertical
  src/inflate.js       décompression gzip (certains préréglages Adobe sont compressés)
  src/compat.js        vérification de compatibilité avec la version de Premiere
  src/shortcuts.js     raccourcis clavier du panneau
  src/cleanup.js       analyse et suppression des proxys inutilisés
  assets/done.mp4      son de fin (0,7 s)
  assets/calibration.mp4  vidéo de 1 s (4 Ko) pour l'encodage test du préréglage
  test/                tests Node + ffmpeg
```
