@echo off
:: ITDashboard URL protocol handlers - one-time install per operator station.
::
:: SAFETY MODEL (post-oponentura-4 review):
::  - Each launcher applies a strict allowlist regex on the hostname read
::    from the URL: only [a-zA-Z0-9._-], max 63 chars, non-empty.
::    Anything else -> exit /b 1 without spawning the target tool.
::  - Every arg substitution is double-quoted so cmd metacharacters
::    cannot inject extra args.
::  - PsExec is NOT registered by default (it runs as SYSTEM on the remote).
::    To opt in, run this installer with the argument:  install-itd-handlers.cmd /with-psexec
::  - Registers under HKCU only (no admin needed). Uninstall by deleting
::    HKCU\Software\Classes\itd-* and %LOCALAPPDATA%\ITDashboard\launchers.
::  - Generated launcher fail block never echoes the raw URL to the console
::    (attacker-controllable URLs could embed ANSI escape sequences for
::    terminal manipulation). Raw URL is still recorded in last-itd-*.log.
::
:: ADMIN CREDENTIALS (per-launch):
::  Default (ITD_ADMIN_USER unset): launcher prompts in CMD for the admin
::  account, then runas /netonly opens Windows credential dialog for password.
::  Last typed admin user is cached in
::  %LOCALAPPDATA%\ITDashboard\launchers\last-admin-user.txt for pre-fill
::  on next launch (Enter accepts). Password is never persisted.
::  Overrides: ITD_ADMIN_USER=AXINETWORK\trnka_admin (fixed pre-fill),
::  ITD_ADMIN_USER=current (no admin wrap, run as current user).
::
:: NEW LAUNCHER itd-ps:// (PowerShell Remote via Enter-PSSession):
::  Uses PowerShell Get-Credential for a native both-fields dialog.
::  PowerShell -Command inline form bypasses .ps1 ExecutionPolicy
::  restrictions (works on GPO AllSigned workstations).
::
:: BROWSER HINT: when prompted "Allow this site to open these links?" do
::   NOT tick "Always allow". Per-click prompt is your second layer of
::   defense against unrelated websites probing the protocol.

setlocal EnableExtensions
set WITH_PSEXEC=0
set MACHINE_INSTALL=0
set UNINSTALL_HKCU=0
for %%a in (%*) do (
  if /i "%%a"=="/with-psexec"    set WITH_PSEXEC=1
  if /i "%%a"=="/machine"        set MACHINE_INSTALL=1
  if /i "%%a"=="/uninstall-hkcu" set UNINSTALL_HKCU=1
)

if "%UNINSTALL_HKCU%"=="1" (
  echo.
  echo Removing per-user HKCU itd-* registrations + LOCALAPPDATA launcher dir
  echo for current Windows user %USERNAME%...
  for %%s in (mmc services eventvwr taskschd rdp explorer ps psexec) do (
    reg delete "HKCU\Software\Classes\itd-%%s" /f >nul 2>&1
  )
  if exist "%LOCALAPPDATA%\ITDashboard\launchers" rmdir /s /q "%LOCALAPPDATA%\ITDashboard\launchers"
  echo Done.
  echo.
  echo If a machine-wide install is present in HKLM + ProgramData, your
  echo itd-* protocol clicks will now use those handlers ^(HKCU no longer
  echo shadows HKLM for this Windows user^).
  echo.
  pause
  exit /b 0
)

if "%MACHINE_INSTALL%"=="1" (
  net session >nul 2>&1
  if errorlevel 1 (
    echo.
    echo ERROR: /machine install requires admin elevation.
    echo Run this script from an elevated cmd / PowerShell.
    echo.
    echo From elevated PowerShell:
    echo   ^& "%~f0" /machine
    echo.
    pause
    exit /b 2
  )
  set "BASE=%ProgramData%\ITDashboard\launchers"
  set "REGHIVE=HKLM"
  set "SCOPE_LABEL=MACHINE-WIDE (HKLM + ProgramData)"
) else (
  set "BASE=%LOCALAPPDATA%\ITDashboard\launchers"
  set "REGHIVE=HKCU"
  set "SCOPE_LABEL=PER-USER (HKCU + LOCALAPPDATA)"
)

if not exist "%BASE%" mkdir "%BASE%"

echo Install scope: %SCOPE_LABEL%
echo Writing launcher scripts to "%BASE%" ...

call :write_mmc_launcher itd-mmc      compmgmt.msc
call :write_mmc_launcher itd-services services.msc
call :write_mmc_launcher itd-eventvwr eventvwr.msc
call :write_mmc_launcher itd-taskschd taskschd.msc
call :write_rdp_launcher
call :write_explorer_launcher
call :write_ps_launcher
if "%WITH_PSEXEC%"=="1" call :write_psexec_launcher

echo Registering protocol handlers under %REGHIVE% ...

call :register mmc       "ITDashboard MMC (Computer Management)"
call :register services  "ITDashboard MMC (services.msc)"
call :register eventvwr  "ITDashboard MMC (Event Viewer)"
call :register taskschd  "ITDashboard MMC (Task Scheduler)"
call :register rdp       "ITDashboard RDP (mstsc)"
call :register explorer  "ITDashboard explorer share"
call :register ps        "ITDashboard PowerShell Remote (Enter-PSSession)"
if "%WITH_PSEXEC%"=="1" call :register psexec "ITDashboard PsExec cmd"

echo.
echo ============================================================
echo  Done. Launch buttons in the Actions modal will now open
echo  the target tool directly.
echo.
echo  IMPORTANT: when the browser asks once whether to allow the
echo  itd-* protocol, do NOT tick "Always allow". The per-click
echo  prompt is a second defense layer.
echo.
echo  All launchers reject hostnames that contain anything other
echo  than letters, digits, dot, dash or underscore (max 63 chars).
echo.
echo  ADMIN CREDENTIALS: by default (ITD_ADMIN_USER unset) every Launch
echo  first prompts in CMD for the admin account ^(empty the first time,
echo  pre-fills the last typed user on subsequent runs - Enter accepts^),
echo  then opens the Windows credential dialog for the password. The
echo  password is never persisted. No per-user setup needed; this default
echo  works for multi-admin workstations where several IT specialists
echo  share one operator PC. Overrides ^(optional^):
echo    setx ITD_ADMIN_USER AXINETWORK\trnka_admin
echo      = fixed pre-filled user, dialog asks only for password
echo    setx ITD_ADMIN_USER current
echo      = run launchers as your current Windows user, no admin wrap
if "%WITH_PSEXEC%"=="1" (
  echo.
  echo  PsExec handler INSTALLED ^(opt-in via /with-psexec^).
) else (
  echo.
  echo  PsExec handler NOT installed. Re-run with /with-psexec to add.
)
echo.
echo  Scope: %SCOPE_LABEL%
if "%MACHINE_INSTALL%"=="1" (
  echo  Installed for ALL Windows users on this workstation.
  echo  HKCU registrations from prior per-user installs ^(if any^)
  echo  will SHADOW this machine-wide install for those users.
  echo  Affected users should run: install-itd-handlers.cmd /uninstall-hkcu
) else (
  echo  Installed for current Windows user only ^(%USERNAME%^).
  echo  Other Windows users on this workstation need to run this script
  echo  themselves, or an admin can run it once with /machine flag for
  echo  workstation-wide install.
)
echo.
echo  To remove: delete  %BASE%
echo             delete  %REGHIVE%\Software\Classes\itd-*  in regedit
echo ============================================================
echo.
pause
exit /b 0

:: ============================================================
:: Launcher writers.  Each emits a .cmd whose body:
::   1. strips the scheme + any trailing slash
::   2. validates the remaining hostname via findstr /R allowlist
::   3. caps length at 63 chars (NetBIOS / AD compatibility)
::   4. quotes the host arg passed to the target tool
::   5. keeps the console open only on validation/setup failure
:: ============================================================

:write_mmc_launcher
:: %1 = scheme suffix (e.g. itd-mmc),  %2 = .msc snap-in name
> "%BASE%\%1.cmd" echo @echo off
>>"%BASE%\%1.cmd" echo setlocal EnableExtensions EnableDelayedExpansion
>>"%BASE%\%1.cmd" echo if not exist "%%LOCALAPPDATA%%\ITDashboard\launchers" mkdir "%%LOCALAPPDATA%%\ITDashboard\launchers" ^>nul 2^>^&1
>>"%BASE%\%1.cmd" echo set "log=%%LOCALAPPDATA%%\ITDashboard\launchers\last-%%~n0.log"
>>"%BASE%\%1.cmd" echo set "url=%%~1"
>>"%BASE%\%1.cmd" echo set "host=%%url:%1://=%%"
>>"%BASE%\%1.cmd" echo set "host=%%host:/=%%"
>>"%BASE%\%1.cmd" echo if not defined host ^(set "reason=empty_host" ^& goto :fail^)
>>"%BASE%\%1.cmd" echo if not "!host:~63,1!"=="" ^(set "reason=host_too_long" ^& goto :fail^)
>>"%BASE%\%1.cmd" echo echo !host!^| findstr /R /X "[a-zA-Z0-9._-][a-zA-Z0-9._-]*" ^>nul ^|^| ^(set "reason=invalid_host_chars" ^& goto :fail^)
>>"%BASE%\%1.cmd" echo ^>^>"%%log%%" echo [%%date%% %%time%%] launching %1 url="!url!" host="!host!"
>>"%BASE%\%1.cmd" echo if not defined ITD_ADMIN_USER set "ITD_ADMIN_USER=ask"
>>"%BASE%\%1.cmd" echo if /i "%%ITD_ADMIN_USER%%"=="ask" goto :ask_mode
>>"%BASE%\%1.cmd" echo if /i "%%ITD_ADMIN_USER%%"=="current" goto :no_admin_mode
>>"%BASE%\%1.cmd" echo goto :preset_mode
>>"%BASE%\%1.cmd" echo :ask_mode
>>"%BASE%\%1.cmd" echo set "lastuserfile=%%LOCALAPPDATA%%\ITDashboard\launchers\last-admin-user.txt"
>>"%BASE%\%1.cmd" echo set "lastuser="
>>"%BASE%\%1.cmd" echo if exist "!lastuserfile!" set /p lastuser=^<"!lastuserfile!"
>>"%BASE%\%1.cmd" echo if defined lastuser ^(
>>"%BASE%\%1.cmd" echo   set /p adminuser=Admin account [Enter ^= !lastuser!]:
>>"%BASE%\%1.cmd" echo ^) else ^(
>>"%BASE%\%1.cmd" echo   set /p adminuser=Admin account [DOMAIN\user]:
>>"%BASE%\%1.cmd" echo ^)
>>"%BASE%\%1.cmd" echo if not defined adminuser if defined lastuser set "adminuser=!lastuser!"
>>"%BASE%\%1.cmd" echo if not defined adminuser ^(set "reason=admin_user_not_entered" ^& goto :fail^)
>>"%BASE%\%1.cmd" echo if not "!adminuser:~128,1!"=="" ^(set "reason=admin_user_too_long" ^& goto :fail^)
>>"%BASE%\%1.cmd" echo ^>"!lastuserfile!" echo !adminuser!
>>"%BASE%\%1.cmd" echo start "" runas /user:"!adminuser!" /netonly "mmc.exe %2 /computer=!host!"
>>"%BASE%\%1.cmd" echo goto :eof
>>"%BASE%\%1.cmd" echo :preset_mode
>>"%BASE%\%1.cmd" echo start "" runas /user:"%%ITD_ADMIN_USER%%" /netonly "mmc.exe %2 /computer=!host!"
>>"%BASE%\%1.cmd" echo goto :eof
>>"%BASE%\%1.cmd" echo :no_admin_mode
>>"%BASE%\%1.cmd" echo start "" mmc.exe %2 /computer="!host!"
>>"%BASE%\%1.cmd" echo goto :eof
call :append_common_footer "%BASE%\%1.cmd"
goto :eof

:write_rdp_launcher
> "%BASE%\itd-rdp.cmd" echo @echo off
>>"%BASE%\itd-rdp.cmd" echo setlocal EnableExtensions EnableDelayedExpansion
>>"%BASE%\itd-rdp.cmd" echo if not exist "%%LOCALAPPDATA%%\ITDashboard\launchers" mkdir "%%LOCALAPPDATA%%\ITDashboard\launchers" ^>nul 2^>^&1
>>"%BASE%\itd-rdp.cmd" echo set "log=%%LOCALAPPDATA%%\ITDashboard\launchers\last-%%~n0.log"
>>"%BASE%\itd-rdp.cmd" echo set "url=%%~1"
>>"%BASE%\itd-rdp.cmd" echo set "host=%%url:itd-rdp://=%%"
>>"%BASE%\itd-rdp.cmd" echo set "host=%%host:/=%%"
>>"%BASE%\itd-rdp.cmd" echo if not defined host ^(set "reason=empty_host" ^& goto :fail^)
>>"%BASE%\itd-rdp.cmd" echo if not "!host:~63,1!"=="" ^(set "reason=host_too_long" ^& goto :fail^)
>>"%BASE%\itd-rdp.cmd" echo echo !host!^| findstr /R /X "[a-zA-Z0-9._-][a-zA-Z0-9._-]*" ^>nul ^|^| ^(set "reason=invalid_host_chars" ^& goto :fail^)
>>"%BASE%\itd-rdp.cmd" echo ^>^>"%%log%%" echo [%%date%% %%time%%] launching itd-rdp url="!url!" host="!host!"
>>"%BASE%\itd-rdp.cmd" echo if not defined ITD_ADMIN_USER set "ITD_ADMIN_USER=ask"
>>"%BASE%\itd-rdp.cmd" echo if /i "%%ITD_ADMIN_USER%%"=="ask" goto :ask_mode
>>"%BASE%\itd-rdp.cmd" echo if /i "%%ITD_ADMIN_USER%%"=="current" goto :no_admin_mode
>>"%BASE%\itd-rdp.cmd" echo goto :preset_mode
>>"%BASE%\itd-rdp.cmd" echo :ask_mode
>>"%BASE%\itd-rdp.cmd" echo set "lastuserfile=%%LOCALAPPDATA%%\ITDashboard\launchers\last-admin-user.txt"
>>"%BASE%\itd-rdp.cmd" echo set "lastuser="
>>"%BASE%\itd-rdp.cmd" echo if exist "!lastuserfile!" set /p lastuser=^<"!lastuserfile!"
>>"%BASE%\itd-rdp.cmd" echo if defined lastuser ^(
>>"%BASE%\itd-rdp.cmd" echo   set /p adminuser=Admin account [Enter ^= !lastuser!]:
>>"%BASE%\itd-rdp.cmd" echo ^) else ^(
>>"%BASE%\itd-rdp.cmd" echo   set /p adminuser=Admin account [DOMAIN\user]:
>>"%BASE%\itd-rdp.cmd" echo ^)
>>"%BASE%\itd-rdp.cmd" echo if not defined adminuser if defined lastuser set "adminuser=!lastuser!"
>>"%BASE%\itd-rdp.cmd" echo if not defined adminuser ^(set "reason=admin_user_not_entered" ^& goto :fail^)
>>"%BASE%\itd-rdp.cmd" echo if not "!adminuser:~128,1!"=="" ^(set "reason=admin_user_too_long" ^& goto :fail^)
>>"%BASE%\itd-rdp.cmd" echo ^>"!lastuserfile!" echo !adminuser!
>>"%BASE%\itd-rdp.cmd" echo start "" runas /user:"!adminuser!" /netonly "mstsc.exe /v:!host!"
>>"%BASE%\itd-rdp.cmd" echo goto :eof
>>"%BASE%\itd-rdp.cmd" echo :preset_mode
>>"%BASE%\itd-rdp.cmd" echo start "" runas /user:"%%ITD_ADMIN_USER%%" /netonly "mstsc.exe /v:!host!"
>>"%BASE%\itd-rdp.cmd" echo goto :eof
>>"%BASE%\itd-rdp.cmd" echo :no_admin_mode
>>"%BASE%\itd-rdp.cmd" echo start "" mstsc.exe /v:"!host!"
>>"%BASE%\itd-rdp.cmd" echo goto :eof
call :append_common_footer "%BASE%\itd-rdp.cmd"
goto :eof

:write_explorer_launcher
:: URL: itd-explorer://HOSTNAME/LETTER  (e.g. itd-explorer://ZAST5W11/C)
> "%BASE%\itd-explorer.cmd" echo @echo off
>>"%BASE%\itd-explorer.cmd" echo setlocal EnableExtensions EnableDelayedExpansion
>>"%BASE%\itd-explorer.cmd" echo if not exist "%%LOCALAPPDATA%%\ITDashboard\launchers" mkdir "%%LOCALAPPDATA%%\ITDashboard\launchers" ^>nul 2^>^&1
>>"%BASE%\itd-explorer.cmd" echo set "log=%%LOCALAPPDATA%%\ITDashboard\launchers\last-%%~n0.log"
>>"%BASE%\itd-explorer.cmd" echo set "url=%%~1"
>>"%BASE%\itd-explorer.cmd" echo set "rest=%%url:itd-explorer://=%%"
>>"%BASE%\itd-explorer.cmd" echo if not defined rest ^(set "reason=empty_path" ^& goto :fail^)
>>"%BASE%\itd-explorer.cmd" echo for /f "tokens=1,2 delims=/" %%%%a in ("!rest!") do set "host=%%%%a" ^& set "letter=%%%%b"
>>"%BASE%\itd-explorer.cmd" echo if not defined host ^(set "reason=empty_host" ^& goto :fail^)
>>"%BASE%\itd-explorer.cmd" echo if not defined letter ^(set "reason=empty_drive_letter" ^& goto :fail^)
>>"%BASE%\itd-explorer.cmd" echo if not "!host:~63,1!"=="" ^(set "reason=host_too_long" ^& goto :fail^)
>>"%BASE%\itd-explorer.cmd" echo echo !host!^| findstr /R /X "[a-zA-Z0-9._-][a-zA-Z0-9._-]*" ^>nul ^|^| ^(set "reason=invalid_host_chars" ^& goto :fail^)
>>"%BASE%\itd-explorer.cmd" echo echo !letter!^| findstr /R /X "[a-zA-Z]" ^>nul ^|^| ^(set "reason=invalid_drive_letter" ^& goto :fail^)
>>"%BASE%\itd-explorer.cmd" echo ^>^>"%%log%%" echo [%%date%% %%time%%] launching itd-explorer url="!url!" host="!host!" letter="!letter!"
>>"%BASE%\itd-explorer.cmd" echo if not defined ITD_ADMIN_USER set "ITD_ADMIN_USER=ask"
>>"%BASE%\itd-explorer.cmd" echo if /i "%%ITD_ADMIN_USER%%"=="ask" goto :ask_mode
>>"%BASE%\itd-explorer.cmd" echo if /i "%%ITD_ADMIN_USER%%"=="current" goto :no_admin_mode
>>"%BASE%\itd-explorer.cmd" echo goto :preset_mode
>>"%BASE%\itd-explorer.cmd" echo :ask_mode
>>"%BASE%\itd-explorer.cmd" echo set "lastuserfile=%%LOCALAPPDATA%%\ITDashboard\launchers\last-admin-user.txt"
>>"%BASE%\itd-explorer.cmd" echo set "lastuser="
>>"%BASE%\itd-explorer.cmd" echo if exist "!lastuserfile!" set /p lastuser=^<"!lastuserfile!"
>>"%BASE%\itd-explorer.cmd" echo if defined lastuser ^(
>>"%BASE%\itd-explorer.cmd" echo   set /p adminuser=Admin account [Enter ^= !lastuser!]:
>>"%BASE%\itd-explorer.cmd" echo ^) else ^(
>>"%BASE%\itd-explorer.cmd" echo   set /p adminuser=Admin account [DOMAIN\user]:
>>"%BASE%\itd-explorer.cmd" echo ^)
>>"%BASE%\itd-explorer.cmd" echo if not defined adminuser if defined lastuser set "adminuser=!lastuser!"
>>"%BASE%\itd-explorer.cmd" echo if not defined adminuser ^(set "reason=admin_user_not_entered" ^& goto :fail^)
>>"%BASE%\itd-explorer.cmd" echo if not "!adminuser:~128,1!"=="" ^(set "reason=admin_user_too_long" ^& goto :fail^)
>>"%BASE%\itd-explorer.cmd" echo ^>"!lastuserfile!" echo !adminuser!
>>"%BASE%\itd-explorer.cmd" echo start "" runas /user:"!adminuser!" /netonly "explorer.exe \\!host!\!letter!$"
>>"%BASE%\itd-explorer.cmd" echo goto :eof
>>"%BASE%\itd-explorer.cmd" echo :preset_mode
>>"%BASE%\itd-explorer.cmd" echo start "" runas /user:"%%ITD_ADMIN_USER%%" /netonly "explorer.exe \\!host!\!letter!$"
>>"%BASE%\itd-explorer.cmd" echo goto :eof
>>"%BASE%\itd-explorer.cmd" echo :no_admin_mode
>>"%BASE%\itd-explorer.cmd" echo start "" explorer.exe "\\!host!\!letter!$"
>>"%BASE%\itd-explorer.cmd" echo goto :eof
call :append_common_footer "%BASE%\itd-explorer.cmd"
goto :eof

:write_psexec_launcher
:: Opt-in only. PsExec spawns cmd as SYSTEM on the remote - even with strict
:: hostname validation this is more dangerous than the read-ish snap-ins.
> "%BASE%\itd-psexec.cmd" echo @echo off
>>"%BASE%\itd-psexec.cmd" echo setlocal EnableExtensions EnableDelayedExpansion
>>"%BASE%\itd-psexec.cmd" echo if not exist "%%LOCALAPPDATA%%\ITDashboard\launchers" mkdir "%%LOCALAPPDATA%%\ITDashboard\launchers" ^>nul 2^>^&1
>>"%BASE%\itd-psexec.cmd" echo set "log=%%LOCALAPPDATA%%\ITDashboard\launchers\last-%%~n0.log"
>>"%BASE%\itd-psexec.cmd" echo set "url=%%~1"
>>"%BASE%\itd-psexec.cmd" echo set "host=%%url:itd-psexec://=%%"
>>"%BASE%\itd-psexec.cmd" echo set "host=%%host:/=%%"
>>"%BASE%\itd-psexec.cmd" echo if not defined host ^(set "reason=empty_host" ^& goto :fail^)
>>"%BASE%\itd-psexec.cmd" echo if not "!host:~63,1!"=="" ^(set "reason=host_too_long" ^& goto :fail^)
>>"%BASE%\itd-psexec.cmd" echo echo !host!^| findstr /R /X "[a-zA-Z0-9._-][a-zA-Z0-9._-]*" ^>nul ^|^| ^(set "reason=invalid_host_chars" ^& goto :fail^)
>>"%BASE%\itd-psexec.cmd" echo ^>^>"%%log%%" echo [%%date%% %%time%%] launching itd-psexec url="!url!" host="!host!"
>>"%BASE%\itd-psexec.cmd" echo if not defined ITD_ADMIN_USER set "ITD_ADMIN_USER=ask"
>>"%BASE%\itd-psexec.cmd" echo if /i "%%ITD_ADMIN_USER%%"=="ask" goto :ask_mode
>>"%BASE%\itd-psexec.cmd" echo if /i "%%ITD_ADMIN_USER%%"=="current" goto :no_admin_mode
>>"%BASE%\itd-psexec.cmd" echo goto :preset_mode
>>"%BASE%\itd-psexec.cmd" echo :ask_mode
>>"%BASE%\itd-psexec.cmd" echo set "lastuserfile=%%LOCALAPPDATA%%\ITDashboard\launchers\last-admin-user.txt"
>>"%BASE%\itd-psexec.cmd" echo set "lastuser="
>>"%BASE%\itd-psexec.cmd" echo if exist "!lastuserfile!" set /p lastuser=^<"!lastuserfile!"
>>"%BASE%\itd-psexec.cmd" echo if defined lastuser ^(
>>"%BASE%\itd-psexec.cmd" echo   set /p adminuser=Admin account [Enter ^= !lastuser!]:
>>"%BASE%\itd-psexec.cmd" echo ^) else ^(
>>"%BASE%\itd-psexec.cmd" echo   set /p adminuser=Admin account [DOMAIN\user]:
>>"%BASE%\itd-psexec.cmd" echo ^)
>>"%BASE%\itd-psexec.cmd" echo if not defined adminuser if defined lastuser set "adminuser=!lastuser!"
>>"%BASE%\itd-psexec.cmd" echo if not defined adminuser ^(set "reason=admin_user_not_entered" ^& goto :fail^)
>>"%BASE%\itd-psexec.cmd" echo if not "!adminuser:~128,1!"=="" ^(set "reason=admin_user_too_long" ^& goto :fail^)
>>"%BASE%\itd-psexec.cmd" echo ^>"!lastuserfile!" echo !adminuser!
>>"%BASE%\itd-psexec.cmd" echo start "" runas /user:"!adminuser!" /netonly "cmd /k psexec /accepteula \\!host! cmd.exe"
>>"%BASE%\itd-psexec.cmd" echo goto :eof
>>"%BASE%\itd-psexec.cmd" echo :preset_mode
>>"%BASE%\itd-psexec.cmd" echo start "" runas /user:"%%ITD_ADMIN_USER%%" /netonly "cmd /k psexec /accepteula \\!host! cmd.exe"
>>"%BASE%\itd-psexec.cmd" echo goto :eof
>>"%BASE%\itd-psexec.cmd" echo :no_admin_mode
>>"%BASE%\itd-psexec.cmd" echo start "" cmd /k psexec /accepteula "\\!host!" cmd.exe
>>"%BASE%\itd-psexec.cmd" echo goto :eof
call :append_common_footer "%BASE%\itd-psexec.cmd"
goto :eof

:write_ps_launcher
:: Opens a PowerShell console with Enter-PSSession -ComputerName !host! and a
:: native Windows Get-Credential dialog. The dialog is empty on first use and
:: pre-fills the last typed UserName on subsequent runs (per-Windows-user cache
:: at %LOCALAPPDATA%\ITDashboard\launchers\last-admin-user.txt, shared with the
:: cmd ask-mode dispatch above). Password is never persisted.
> "%BASE%\itd-ps.cmd" echo @echo off
>>"%BASE%\itd-ps.cmd" echo setlocal EnableExtensions EnableDelayedExpansion
>>"%BASE%\itd-ps.cmd" echo if not exist "%%LOCALAPPDATA%%\ITDashboard\launchers" mkdir "%%LOCALAPPDATA%%\ITDashboard\launchers" ^>nul 2^>^&1
>>"%BASE%\itd-ps.cmd" echo set "log=%%LOCALAPPDATA%%\ITDashboard\launchers\last-%%~n0.log"
>>"%BASE%\itd-ps.cmd" echo set "url=%%~1"
>>"%BASE%\itd-ps.cmd" echo set "host=%%url:itd-ps://=%%"
>>"%BASE%\itd-ps.cmd" echo set "host=%%host:/=%%"
>>"%BASE%\itd-ps.cmd" echo if not defined host ^(set "reason=empty_host" ^& goto :fail^)
>>"%BASE%\itd-ps.cmd" echo if not "!host:~63,1!"=="" ^(set "reason=host_too_long" ^& goto :fail^)
>>"%BASE%\itd-ps.cmd" echo echo !host!^| findstr /R /X "[a-zA-Z0-9._-][a-zA-Z0-9._-]*" ^>nul ^|^| ^(set "reason=invalid_host_chars" ^& goto :fail^)
>>"%BASE%\itd-ps.cmd" echo ^>^>"%%log%%" echo [%%date%% %%time%%] launching itd-ps url="!url!" host="!host!"
>>"%BASE%\itd-ps.cmd" echo set "lastuserfile=%%LOCALAPPDATA%%\ITDashboard\launchers\last-admin-user.txt"
>>"%BASE%\itd-ps.cmd" echo if not defined ITD_ADMIN_USER set "ITD_ADMIN_USER=ask"
>>"%BASE%\itd-ps.cmd" echo if /i "%%ITD_ADMIN_USER%%"=="ask" goto :ask_mode
>>"%BASE%\itd-ps.cmd" echo if /i "%%ITD_ADMIN_USER%%"=="current" goto :no_admin_mode
>>"%BASE%\itd-ps.cmd" echo goto :preset_mode
>>"%BASE%\itd-ps.cmd" echo :ask_mode
>>"%BASE%\itd-ps.cmd" echo start "" powershell -NoExit -Command "$f='!lastuserfile!'; $u=if(Test-Path $f){(Get-Content $f -TotalCount 1).Trim()}else{''}; $c=Get-Credential -UserName $u -Message 'Admin credentials for !host!'; if($c -and $c.UserName -match '^[A-Za-z0-9._@\\-]+$'){$c.UserName | Out-File -Encoding ASCII -NoNewline $f}; if($c){Enter-PSSession -ComputerName '!host!' -Credential $c}"
>>"%BASE%\itd-ps.cmd" echo goto :eof
>>"%BASE%\itd-ps.cmd" echo :preset_mode
>>"%BASE%\itd-ps.cmd" echo start "" powershell -NoExit -Command "$c=Get-Credential -UserName '%%ITD_ADMIN_USER%%' -Message 'Admin credentials for !host!'; if($c){Enter-PSSession -ComputerName '!host!' -Credential $c}"
>>"%BASE%\itd-ps.cmd" echo goto :eof
>>"%BASE%\itd-ps.cmd" echo :no_admin_mode
>>"%BASE%\itd-ps.cmd" echo start "" powershell -NoExit -Command "Enter-PSSession -ComputerName '!host!'"
>>"%BASE%\itd-ps.cmd" echo goto :eof
call :append_common_footer "%BASE%\itd-ps.cmd"
goto :eof

:append_common_footer
:: Console echoes intentionally print only validated/derived fields (!reason!,
:: !host!, !letter!) — all regex-allowlisted to [a-zA-Z0-9._-] or a single
:: letter. The raw !url! is NEVER echoed to the console because an attacker-
:: controlled URL could contain ANSI escape sequences or other control chars
:: that manipulate the operator's terminal (console reflected injection).
:: The raw !url! is still recorded in the log file (file write is not subject
:: to terminal escape interpretation, and ops needs the original input for
:: helpdesk diagnosis).
>>"%~1" echo goto :eof
>>"%~1" echo :fail
>>"%~1" echo echo.
>>"%~1" echo echo ITDashboard launcher failed: !reason!
>>"%~1" echo if defined host echo Host: "!host!"
>>"%~1" echo if defined letter echo Drive letter: "!letter!"
>>"%~1" echo echo.
>>"%~1" echo echo Allowed host characters: letters, digits, dot, dash, underscore; max 63 chars.
>>"%~1" echo echo Explorer handler accepts only drive letters, e.g. itd-explorer://PC/C
>>"%~1" echo echo.
>>"%~1" echo ^>^>"%%log%%" echo [%%date%% %%time%%] failed %%~nx0 reason=!reason! url="!url!" host="!host!" letter="!letter!"
>>"%~1" echo echo Full URL recorded in: %%log%%
>>"%~1" echo pause
>>"%~1" echo exit /b 1
goto :eof

:register
:: %1 = scheme suffix (e.g. mmc), %2 = description
:: Hive is selected by %REGHIVE% (HKLM for /machine, HKCU otherwise).
reg add "%REGHIVE%\Software\Classes\itd-%1" /ve /d "URL:%~2" /f >nul
reg add "%REGHIVE%\Software\Classes\itd-%1" /v "URL Protocol" /d "" /f >nul
reg add "%REGHIVE%\Software\Classes\itd-%1\shell" /ve /d "" /f >nul
reg add "%REGHIVE%\Software\Classes\itd-%1\shell\open" /ve /d "" /f >nul
reg add "%REGHIVE%\Software\Classes\itd-%1\shell\open\command" /ve /d "\"%BASE%\itd-%1.cmd\" \"%%1\"" /f >nul
goto :eof
