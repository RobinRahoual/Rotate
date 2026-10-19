@echo off
setlocal
title Installation de Rotate

rem Installe le plugin Rotate avec l'installeur officiel d'Adobe (UPIA),
rem utile quand le double-clic sur le fichier .ccx ne fait rien.
rem Pas de parentheses dans les messages : elles cassent les blocs des fichiers .bat.

set "LOG=%~dp0installation-rotate.log"
set "UPIA_REL=Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
set "UPIA=%CommonProgramW6432%\%UPIA_REL%"
if not exist "%UPIA%" set "UPIA=%CommonProgramFiles%\%UPIA_REL%"
if not exist "%UPIA%" set "UPIA=%ProgramFiles%\Common Files\%UPIA_REL%"
if not exist "%UPIA%" goto no_upia

set "CCX="
for %%F in ("%~dp0*.ccx") do set "CCX=%%~fF"
if not defined CCX goto no_ccx

echo Installation de :
echo   "%CCX%"
echo.
"%UPIA%" /install "%CCX%" > "%LOG%" 2>&1
set "RESULT=%ERRORLEVEL%"
type "%LOG%"
echo.
echo ----- Plugins installes -----
"%UPIA%" /list all
echo -----------------------------
echo.
if not "%RESULT%"=="0" goto failed
echo Termine. Redemarre Premiere Pro, puis : Fenetre ^> Plugins UXP ^> Rotate
goto end

:failed
echo L'installation a echoue, code %RESULT%.
echo Detail enregistre dans : %LOG%
echo Fais une capture de cette fenetre et envoie-la a @robin.rahoual.
goto end

:no_upia
echo L'installeur d'Adobe est introuvable. Chemin attendu :
echo   %CommonProgramFiles%\%UPIA_REL%
echo Verifie que l'application Creative Cloud est installee, ou reinstalle-la.
goto end

:no_ccx
echo Aucun fichier .ccx trouve dans le meme dossier que ce script.
echo Place le fichier Rotate-xxx.ccx a cote de ce script, puis relance-le.
goto end

:end
echo.
pause
