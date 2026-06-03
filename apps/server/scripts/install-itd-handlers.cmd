@echo off
:: ITDashboard URL protocol handlers — one-time install per operator station.
:: Registers itd-mmc://, itd-services://, itd-eventvwr://, itd-taskschd://,
:: itd-rdp://, itd-psexec://, itd-explorer:// under HKCU (no admin needed).
:: After install, clicking the "Launch" buttons in the Actions modal directly
:: opens the respective tool against the target PC.
::
:: Run: double-click this file, or from cmd:  install-itd-handlers.cmd
:: Uninstall: delete the HKCU\Software\Classes\itd-* keys and the launcher dir.

setlocal EnableExtensions
set BASE=%LOCALAPPDATA%\ITDashboard\launchers
if not exist "%BASE%" mkdir "%BASE%"

echo Writing launcher scripts to "%BASE%" ...

:: --- itd-mmc → Computer Management ---
> "%BASE%\itd-mmc.cmd" echo @echo off
>>"%BASE%\itd-mmc.cmd" echo set url=%%1
>>"%BASE%\itd-mmc.cmd" echo set host=%%url:itd-mmc://=%%
>>"%BASE%\itd-mmc.cmd" echo set host=%%host:/=%%
>>"%BASE%\itd-mmc.cmd" echo if "%%host%%"=="" exit /b 1
>>"%BASE%\itd-mmc.cmd" echo start "" mmc.exe compmgmt.msc /computer=%%host%%

:: --- itd-services → services.msc ---
> "%BASE%\itd-services.cmd" echo @echo off
>>"%BASE%\itd-services.cmd" echo set url=%%1
>>"%BASE%\itd-services.cmd" echo set host=%%url:itd-services://=%%
>>"%BASE%\itd-services.cmd" echo set host=%%host:/=%%
>>"%BASE%\itd-services.cmd" echo if "%%host%%"=="" exit /b 1
>>"%BASE%\itd-services.cmd" echo start "" mmc.exe services.msc /computer=%%host%%

:: --- itd-eventvwr → eventvwr.msc ---
> "%BASE%\itd-eventvwr.cmd" echo @echo off
>>"%BASE%\itd-eventvwr.cmd" echo set url=%%1
>>"%BASE%\itd-eventvwr.cmd" echo set host=%%url:itd-eventvwr://=%%
>>"%BASE%\itd-eventvwr.cmd" echo set host=%%host:/=%%
>>"%BASE%\itd-eventvwr.cmd" echo if "%%host%%"=="" exit /b 1
>>"%BASE%\itd-eventvwr.cmd" echo start "" mmc.exe eventvwr.msc /computer=%%host%%

:: --- itd-taskschd → taskschd.msc ---
> "%BASE%\itd-taskschd.cmd" echo @echo off
>>"%BASE%\itd-taskschd.cmd" echo set url=%%1
>>"%BASE%\itd-taskschd.cmd" echo set host=%%url:itd-taskschd://=%%
>>"%BASE%\itd-taskschd.cmd" echo set host=%%host:/=%%
>>"%BASE%\itd-taskschd.cmd" echo if "%%host%%"=="" exit /b 1
>>"%BASE%\itd-taskschd.cmd" echo start "" mmc.exe taskschd.msc /computer=%%host%%

:: --- itd-rdp → mstsc /v:HOST ---
> "%BASE%\itd-rdp.cmd" echo @echo off
>>"%BASE%\itd-rdp.cmd" echo set url=%%1
>>"%BASE%\itd-rdp.cmd" echo set host=%%url:itd-rdp://=%%
>>"%BASE%\itd-rdp.cmd" echo set host=%%host:/=%%
>>"%BASE%\itd-rdp.cmd" echo if "%%host%%"=="" exit /b 1
>>"%BASE%\itd-rdp.cmd" echo start "" mstsc.exe /v:%%host%%

:: --- itd-psexec → cmd via PsExec ---
:: Requires PsExec on PATH (Sysinternals).  /accepteula avoids first-run dialog.
> "%BASE%\itd-psexec.cmd" echo @echo off
>>"%BASE%\itd-psexec.cmd" echo set url=%%1
>>"%BASE%\itd-psexec.cmd" echo set host=%%url:itd-psexec://=%%
>>"%BASE%\itd-psexec.cmd" echo set host=%%host:/=%%
>>"%BASE%\itd-psexec.cmd" echo if "%%host%%"=="" exit /b 1
>>"%BASE%\itd-psexec.cmd" echo start "" cmd /k psexec /accepteula \\%%host%% cmd.exe

:: --- itd-explorer → \\HOST\LETTER$ ---
:: URL format: itd-explorer://HOSTNAME/LETTER  (e.g. itd-explorer://ZAST5W11/C)
> "%BASE%\itd-explorer.cmd" echo @echo off
>>"%BASE%\itd-explorer.cmd" echo set url=%%1
>>"%BASE%\itd-explorer.cmd" echo set rest=%%url:itd-explorer://=%%
>>"%BASE%\itd-explorer.cmd" echo for /f "tokens=1,2 delims=/" %%%%a in ("%%rest%%") do set host=%%%%a^&set letter=%%%%b
>>"%BASE%\itd-explorer.cmd" echo if "%%host%%"=="" exit /b 1
>>"%BASE%\itd-explorer.cmd" echo if "%%letter%%"=="" exit /b 1
>>"%BASE%\itd-explorer.cmd" echo start "" explorer.exe \\%%host%%\%%letter%%$

echo Registering protocol handlers under HKCU ...

call :register mmc       "ITDashboard MMC (Computer Management)"
call :register services  "ITDashboard MMC (services.msc)"
call :register eventvwr  "ITDashboard MMC (Event Viewer)"
call :register taskschd  "ITDashboard MMC (Task Scheduler)"
call :register rdp       "ITDashboard RDP (mstsc)"
call :register psexec    "ITDashboard PsExec cmd"
call :register explorer  "ITDashboard explorer share"

echo.
echo ============================================================
echo  Done. Launch buttons in the Actions modal will now open
echo  the target tool directly.  Browser may ask once whether
echo  to allow the protocol; tick "Always allow" and you're set.
echo.
echo  To remove: delete  %BASE%
echo             delete  HKCU\Software\Classes\itd-*  in regedit
echo ============================================================
echo.
pause
goto :eof

:register
:: %1 = scheme suffix (e.g. mmc), %2 = description
reg add "HKCU\Software\Classes\itd-%1" /ve /d "URL:%~2" /f >nul
reg add "HKCU\Software\Classes\itd-%1" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\itd-%1\shell" /ve /d "" /f >nul
reg add "HKCU\Software\Classes\itd-%1\shell\open" /ve /d "" /f >nul
reg add "HKCU\Software\Classes\itd-%1\shell\open\command" /ve /d "\"%BASE%\itd-%1.cmd\" \"%%1\"" /f >nul
goto :eof
