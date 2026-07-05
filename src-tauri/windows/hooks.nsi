; NOVA NSIS installer hooks.
;
; The app keeps running in the tray and spawns background processes
; (node.exe daemon, aria2c.exe, yt-dlp.exe) from the install directory.
; NSIS cannot delete locked files, so without these hooks an uninstall
; leaves remnants behind and Windows re-offers the installer afterwards.

!macro KillNovaProcesses
  ; Stop every process launched from the install directory
  ; (main app, bundled node daemon, download engines).
  nsExec::Exec `taskkill /f /fi "IMAGENAME eq nova.exe" /t 2>nul`
  Pop $0
  nsExec::Exec `taskkill /f /fi "IMAGENAME eq aria2c.exe" /t 2>nul`
  Pop $0
  nsExec::Exec `taskkill /f /fi "IMAGENAME eq yt-dlp.exe" /t 2>nul`
  Pop $0
  nsExec::Exec `taskkill /f /fi "IMAGENAME eq ffmpeg.exe" /t 2>nul`
  Pop $0
  ; Fallback: kill anything listening on the daemon port.
  nsExec::Exec `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3199 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`
  Pop $0
  Sleep 1000
!macroend

!macro NSIS_HOOK_PREINSTALL
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
  ; Remove Start Menu folder
  RMDir /r "$SMPROGRAMS\Nova Download Manager"
  DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nova Download Manager"
  ; Also remove the per-user Tauri cache/state in case the user wants a full cleanup
  DeleteRegKey HKCU "Software\com.nova.downloadmanager"
!macroend
