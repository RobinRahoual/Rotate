@echo off
chcp 65001 >nul
setlocal
title Installation de Rotate

rem Installe le plugin Rotate avec l'installeur officiel d'Adobe (UPIA),
rem utile quand le double-clic sur le fichier .ccx ne fait rien.

set "UPIA=%CommonProgramFiles%\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
if not exist "%UPIA%" (
  echo L'installeur d'Adobe est introuvable :
  echo   %UPIA%
  echo Verifie que l'application Creative Cloud est installee, ou reinstalle-la.
  echo.
  pause
  exit /b 1
)

set "CCX="
for %%F in ("%~dp0*.ccx") do set "CCX=%%~fF"
if not defined CCX (
  echo Aucun fichier .ccx trouve dans le meme dossier que ce script.
  echo Place Rotate-xxx.ccx a cote de ce fichier puis relance-le.
  echo.
  pause
  exit /b 1
)

echo Installation de :
echo   %CCX%
echo.
"%UPIA%" /install "%CCX%"
set "RESULT=%ERRORLEVEL%"
echo.
if "%RESULT%"=="0" (
  echo Rotate est installe. Redemarre Premiere Pro, puis : Fenetre ^> Plugins UXP ^> Rotate
) else (
  echo L'installation a echoue (code %RESULT%).
  echo Fais une capture de cette fenetre et envoie-la a @robin.rahoual.
)
echo.
pause
