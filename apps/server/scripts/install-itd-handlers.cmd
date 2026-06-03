@echo off
:: ITDashboard URL protocol handlers - one-time install per operator station.
::
:: SAFETY MODEL (post-oponentura-2 review):
::  - Each launcher applies a strict allowlist regex on the hostname read
::    from the URL: only [a-zA-Z0-9._-], max 63 chars, non-empty.
::    Anything else -> exit /b 1 without spawning the target tool.
::  - Every arg substitution is double-quoted so cmd metacharacters
::    cannot inject extra args.
::  - PsExec is NOT registered by default (it runs as SYSTEM on the remote).
::    To opt in, run this installer with the argument:  install-itd-handlers.cmd /with-psexec
::  - Registers under HKCU only (no admin needed). Uninstall by deleting
::    HKCU\Software\Classes\itd-* and %LOCALAPPDATA%\ITDashboard\launchers.
::
:: BROWSER HINT: when prompted "Allow this site to open these links?" do
::   NOT tick "Always allow". Per-click prompt is your second layer of
::   defense against unrelated websites probing the protocol.

setlocal EnableExtensions
set WITH_PSEXEC=0
if /i "%~1"=="/with-psexec" set WITH_PSEXEC=1

set BASE=%LOCALAPPDATA%\ITDashboard\launchers
if not exist "%BASE%" mkdir "%BASE%"

echo Writing launcher scripts to "%BASE%" ...

call :write_mmc_launcher itd-mmc      compmgmt.msc
call :write_mmc_launcher itd-services services.msc
call :write_mmc_launcher itd-eventvwr eventvwr.msc
call :write_mmc_launcher itd-taskschd taskschd.msc
call :write_rdp_launcher
call :write_explorer_launcher
if "%WITH_PSEXEC%"=="1" call :write_psexec_launcher

echo Registering protocol handlers under HKCU ...

call :register mmc       "ITDashboard MMC (Computer Management)"
call :register services  "ITDashboard MMC (services.msc)"
call :register eventvwr  "ITDashboard MMC (Event Viewer)"
call :register taskschd  "ITDashboard MMC (Task Scheduler)"
call :register rdp       "ITDashboard RDP (mstsc)"
call :register explorer  "ITDashboard explorer share"
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
echo  ADMIN ACCOUNT (optional): set ITD_ADMIN_USER user-env-var to
echo  e.g. AXINETWORK\trnka_admin to have each Launch wrap the
echo  command in `runas /netonly` so remote auth uses your admin
echo  credentials. Leave unset to run as your current account.
if "%WITH_PSEXEC%"=="1" (
  echo.
  echo  PsExec handler INSTALLED ^(opt-in via /with-psexec^).
) else (
  echo.
  echo  PsExec handler NOT installed. Re-run with /with-psexec to add.
)
echo.
echo  To remove: delete  %BASE%
echo             delete  HKCU\Software\Classes\itd-*  in regedit
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
>>"%BASE%\%1.cmd" echo set "log=%%LOCALAPPDATA%%\ITDashboard\launchers\last-%%~n0.log"
>>"%BASE%\%1.cmd" echo set "url=%%~1"
>>"%BASE%\%1.cmd" echo set "host=%%url:%1://=%%"
>>"%BASE%\%1.cmd" echo set "host=%%host:/=%%"
>>"%BASE%\%1.cmd" echo if not defined host ^(set "reason=empty_host" ^& goto :fail^)
>>"%BASE%\%1.cmd" echo if not "!host:~63,1!"=="" ^(set "reason=host_too_long" ^& goto :fail^)
>>"%BASE%\%1.cmd" echo echo !host!^| findstr /R /X "[a-zA-Z0-9._-][a-zA-Z0-9._-]*" ^>nul ^|^| ^(set "reason=invalid_host_chars" ^& goto :fail^)
>>"%BASE%\%1.cmd" echo ^>^>"%%log%%" echo [%%date%% %%time%%] launching %1 url="!url!" host="!host!"
>>"%BASE%\%1.cmd" echo if defined ITD_ADMIN_USER ^(
>>"%BASE%\%1.cmd" echo   start "" runas /user:"%%ITD_ADMIN_USER%%" /netonly "mmc.exe %2 /computer=!host!"
>>"%BASE%\%1.cmd" echo ^) else ^(
>>"%BASE%\%1.cmd" echo   start "" mmc.exe %2 /computer="!host!"
>>"%BASE%\%1.cmd" echo ^)
call :append_common_footer "%BASE%\%1.cmd"
goto :eof

:write_rdp_launcher
> "%BASE%\itd-rdp.cmd" echo @echo off
>>"%BASE%\itd-rdp.cmd" echo setlocal EnableExtensions EnableDelayedExpansion
>>"%BASE%\itd-rdp.cmd" echo set "log=%%LOCALAPPDATA%%\ITDashboard\launchers\last-%%~n0.log"
>>"%BASE%\itd-rdp.cmd" echo set "url=%%~1"
>>"%BASE%\itd-rdp.cmd" echo set "host=%%url:itd-rdp://=%%"
>>"%BASE%\itd-rdp.cmd" echo set "host=%%host:/=%%"
>>"%BASE%\itd-rdp.cmd" echo if not defined host ^(set "reason=empty_host" ^& goto :fail^)
>>"%BASE%\itd-rdp.cmd" echo if not "!host:~63,1!"=="" ^(set "reason=host_too_long" ^& goto :fail^)
>>"%BASE%\itd-rdp.cmd" echo echo !host!^| findstr /R /X "[a-zA-Z0-9._-][a-zA-Z0-9._-]*" ^>nul ^|^| ^(set "reason=invalid_host_chars" ^& goto :fail^)
>>"%BASE%\itd-rdp.cmd" echo ^>^>"%%log%%" echo [%%date%% %%time%%] launching itd-rdp url="!url!" host="!host!"
>>"%BASE%\itd-rdp.cmd" echo if defined ITD_ADMIN_USER ^(
>>"%BASE%\itd-rdp.cmd" echo   start "" runas /user:"%%ITD_ADMIN_USER%%" /netonly "mstsc.exe /v:!host!"
>>"%BASE%\itd-rdp.cmd" echo ^) else ^(
>>"%BASE%\itd-rdp.cmd" echo   start "" mstsc.exe /v:"!host!"
>>"%BASE%\itd-rdp.cmd" echo ^)
call :append_common_footer "%BASE%\itd-rdp.cmd"
goto :eof

:write_explorer_launcher
:: URL: itd-explorer://HOSTNAME/LETTER  (e.g. itd-explorer://ZAST5W11/C)
> "%BASE%\itd-explorer.cmd" echo @echo off
>>"%BASE%\itd-explorer.cmd" echo setlocal EnableExtensions EnableDelayedExpansion
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
>>"%BASE%\itd-explorer.cmd" echo if defined ITD_ADMIN_USER ^(
>>"%BASE%\itd-explorer.cmd" echo   start "" runas /user:"%%ITD_ADMIN_USER%%" /netonly "explorer.exe \\!host!\!letter!$"
>>"%BASE%\itd-explorer.cmd" echo ^) else ^(
>>"%BASE%\itd-explorer.cmd" echo   start "" explorer.exe "\\!host!\!letter!$"
>>"%BASE%\itd-explorer.cmd" echo ^)
call :append_common_footer "%BASE%\itd-explorer.cmd"
goto :eof

:write_psexec_launcher
:: Opt-in only. PsExec spawns cmd as SYSTEM on the remote - even with strict
:: hostname validation this is more dangerous than the read-ish snap-ins.
> "%BASE%\itd-psexec.cmd" echo @echo off
>>"%BASE%\itd-psexec.cmd" echo setlocal EnableExtensions EnableDelayedExpansion
>>"%BASE%\itd-psexec.cmd" echo set "log=%%LOCALAPPDATA%%\ITDashboard\launchers\last-%%~n0.log"
>>"%BASE%\itd-psexec.cmd" echo set "url=%%~1"
>>"%BASE%\itd-psexec.cmd" echo set "host=%%url:itd-psexec://=%%"
>>"%BASE%\itd-psexec.cmd" echo set "host=%%host:/=%%"
>>"%BASE%\itd-psexec.cmd" echo if not defined host ^(set "reason=empty_host" ^& goto :fail^)
>>"%BASE%\itd-psexec.cmd" echo if not "!host:~63,1!"=="" ^(set "reason=host_too_long" ^& goto :fail^)
>>"%BASE%\itd-psexec.cmd" echo echo !host!^| findstr /R /X "[a-zA-Z0-9._-][a-zA-Z0-9._-]*" ^>nul ^|^| ^(set "reason=invalid_host_chars" ^& goto :fail^)
>>"%BASE%\itd-psexec.cmd" echo ^>^>"%%log%%" echo [%%date%% %%time%%] launching itd-psexec url="!url!" host="!host!"
>>"%BASE%\itd-psexec.cmd" echo if defined ITD_ADMIN_USER ^(
>>"%BASE%\itd-psexec.cmd" echo   start "" runas /user:"%%ITD_ADMIN_USER%%" /netonly "cmd /k psexec /accepteula \\!host! cmd.exe"
>>"%BASE%\itd-psexec.cmd" echo ^) else ^(
>>"%BASE%\itd-psexec.cmd" echo   start "" cmd /k psexec /accepteula "\\!host!" cmd.exe
>>"%BASE%\itd-psexec.cmd" echo ^)
call :append_common_footer "%BASE%\itd-psexec.cmd"
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
reg add "HKCU\Software\Classes\itd-%1" /ve /d "URL:%~2" /f >nul
reg add "HKCU\Software\Classes\itd-%1" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\itd-%1\shell" /ve /d "" /f >nul
reg add "HKCU\Software\Classes\itd-%1\shell\open" /ve /d "" /f >nul
reg add "HKCU\Software\Classes\itd-%1\shell\open\command" /ve /d "\"%BASE%\itd-%1.cmd\" \"%%1\"" /f >nul
goto :eof
