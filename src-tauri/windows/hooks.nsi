; NOVA NSIS installer hooks.
;
; The app keeps running in the tray and spawns background processes
; (node.exe daemon, aria2c.exe, yt-dlp.exe) from the install directory.
; NSIS cannot delete locked files, so without these hooks an uninstall
; leaves remnants behind and Windows re-offers the installer afterwards.

!macro KillNovaProcesses
  ; Stop every process launched from the install directory
  ; (main app, bundled node daemon, download engines).
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -like '$INSTDIR\*' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  ; Stop anything still listening on the daemon port.
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 3199 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $$_.OwningProcess -Force -ErrorAction SilentlyContinue }"`
  Sleep 500
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Allow clean upgrades over a running installation.
  !insertmacro KillNovaProcesses
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro KillNovaProcesses
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove install-dir leftovers and the uninstall registry entry so Windows
  ; never flags the uninstall as failed or shows the installer again.
  ; App data (settings, history) is NOT touched here: the uninstaller's
  ; confirm page has a built-in "Delete the application data" checkbox,
  ; unchecked by default, and the template deletes
  ; $APPDATA\com.nova.downloadmanager / $LOCALAPPDATA\com.nova.downloadmanager
  ; only when the user checks it.
  RMDir /r "$INSTDIR"
  DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nova Download Manager"
!macroend
