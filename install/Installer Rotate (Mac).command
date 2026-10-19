#!/bin/sh
# Installe le plugin Rotate avec l'installeur officiel d'Adobe (UPIA),
# utile quand le double-clic sur le fichier .ccx ne fait rien.

cd "$(dirname "$0")" || exit 1
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/macOS/UnifiedPluginInstallerAgent"

if [ ! -x "$UPIA" ]; then
  echo "L'installeur d'Adobe est introuvable :"
  echo "  $UPIA"
  echo "Vérifie que l'application Creative Cloud est installée, ou réinstalle-la."
  exit 1
fi

CCX=$(ls -1 ./*.ccx 2>/dev/null | tail -n 1)
if [ -z "$CCX" ]; then
  echo "Aucun fichier .ccx trouvé dans le même dossier que ce script."
  exit 1
fi

echo "Installation de : $PWD/${CCX#./}"
echo
if "$UPIA" --install "$PWD/${CCX#./}"; then
  echo
  echo "Rotate est installé. Redémarre Premiere Pro, puis : Fenêtre > Plugins UXP > Rotate"
else
  echo
  echo "L'installation a échoué. Fais une capture de cette fenêtre et envoie-la à @robin.rahoual."
fi
