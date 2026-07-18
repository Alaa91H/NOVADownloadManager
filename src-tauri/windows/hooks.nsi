; NOVA NSIS installer lifecycle hooks.
;
; Product goals:
; - clean install, safe upgrade, repair-by-rerun, and uninstall lifecycle support
; - stop only NOVA-owned processes before replacing files
; - preserve user data unless the uninstaller app-data option is explicitly used
; - generate and register Native Messaging manifests for bundled browser extension integration
; - remove stale legacy engines/manifests without touching unrelated system tools
; - leave Windows Apps & Features in a clean state after install/uninstall
;
; NSIS/Tauri supplies the standard wizard pages and file extraction. These hooks
; add NOVA-specific maintenance behavior around those phases.
;
; Professional build versioning:
; - NOVA_BUILD_ID: unique CI build identifier (run_id.run_attempt)
; - NOVA_BUILD_COMMIT: short git SHA of the commit
; - NOVA_BUILD_TIMESTAMP: ISO-8601 build timestamp
; These are embedded in the install receipt for traceability.

; Tauri includes this file before the Modern UI pages are inserted, so these
; definitions theme the installer/uninstaller shell and keep branded bitmaps
; sharp on high-DPI displays.

; ---- Color Palette (dark theme) ----
!define NOVA_NSIS_BACKGROUND "0B0E17"
!define NOVA_NSIS_TEXT "F0F4FC"
!define NOVA_NSIS_ACCENT "3B82F6"
!define NOVA_NSIS_SUBTLE "8896B3"

!define MUI_BGCOLOR "${NOVA_NSIS_BACKGROUND}"
!define MUI_TEXTCOLOR "${NOVA_NSIS_TEXT}"
!define MUI_FORCECLASSICCONTROLS
!define MUI_HEADER_TRANSPARENT_TEXT
!define MUI_HEADERIMAGE_BITMAP_STRETCH AspectFitHeight
!define MUI_HEADERIMAGE_UNBITMAP_STRETCH AspectFitHeight
!define MUI_WELCOMEFINISHPAGE_BITMAP_STRETCH AspectFitHeight
!define MUI_UNWELCOMEFINISHPAGE_BITMAP_STRETCH AspectFitHeight
!define MUI_LICENSEPAGE_BGCOLOR ${NOVA_NSIS_BACKGROUND}
!define MUI_DIRECTORYPAGE_BGCOLOR ${NOVA_NSIS_BACKGROUND}
!define MUI_STARTMENUPAGE_BGCOLOR ${NOVA_NSIS_BACKGROUND}
!define MUI_INSTFILESPAGE_COLORS "${NOVA_NSIS_TEXT} ${NOVA_NSIS_BACKGROUND}"
!define MUI_INSTFILESPAGE_COLORBAR "${NOVA_NSIS_ACCENT} ${NOVA_NSIS_BACKGROUND}"

; ---- Fonts (Segoe UI family — sharp on all DPI scales) ----
!define MUI_FONT "Segoe UI"
!define MUI_FONTSIZE 9
!define MUI_WELCOMEFINISHPAGE_FONT "Segoe UI"
!define MUI_WELCOMEFINISHPAGE_FONTSIZE 11
!define MUI_UNWELCOMEFINISHPAGE_FONT "Segoe UI"
!define MUI_UNWELCOMEFINISHPAGE_FONTSIZE 11

!define NOVA_PRODUCT_NAME "Nova Download Manager"
!define NOVA_VENDOR_KEY "Software\NOVA"
!define NOVA_APP_KEY "Software\NOVA\Nova Download Manager"
!define NOVA_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nova Download Manager"
!define NOVA_DAEMON_PORT "3199"
!define NOVA_NATIVE_HOST "com.nova.downloadmanager"
!define NOVA_NATIVE_MANIFEST "$INSTDIR\resources\native-messaging\${NOVA_NATIVE_HOST}.json"
!define NOVA_APP_EXE "$INSTDIR\nova.exe"
!ifndef NOVA_BUILD_ID
  !define NOVA_BUILD_ID ""
!endif
!ifndef NOVA_BUILD_COMMIT
  !define NOVA_BUILD_COMMIT ""
!endif

!macro NovaWriteMarker NAME VALUE
  CreateDirectory "$INSTDIR"
  FileOpen $0 "$INSTDIR\${NAME}" w
  FileWrite $0 "${VALUE}"
  FileClose $0
!macroend

!macro NovaResolveInstallMode
  ; clean       : no prior NOVA installation found
  ; maintenance : prior executable or receipt exists; covers repair and upgrade
  IfFileExists "${NOVA_APP_EXE}" nova_maintenance 0
  IfFileExists "$INSTDIR\nova-install-receipt.ini" nova_maintenance nova_clean
  nova_maintenance:
    StrCpy $1 "maintenance"
    Goto nova_mode_done
  nova_clean:
    StrCpy $1 "clean"
  nova_mode_done:
    CreateDirectory "$INSTDIR"
    !insertmacro NovaWriteMarker ".nova-install-mode" "$1"
    WriteRegStr SHCTX "${NOVA_APP_KEY}" "LastInstallMode" "$1"
    WriteRegStr SHCTX "${NOVA_APP_KEY}" "InstallLocation" "$INSTDIR"
!macroend

!macro NovaStopOwnedProcesses
  ; Stop only processes whose executable lives under this install directory.
  ; This prevents killing unrelated system curl, yt-dlp, ffmpeg, browser, or user tools.
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$install = [System.IO.Path]::GetFullPath('$INSTDIR'); $$names = @('nova','nova-native-host','yt-dlp','ffmpeg','curl'); $$procs = Get-Process -Name $$names -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and ([System.IO.Path]::GetFullPath($$_.Path)).StartsWith($$install, [System.StringComparison]::OrdinalIgnoreCase) }; if ($$procs) { $$procs | Stop-Process -PassThru -ErrorAction SilentlyContinue | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue; $$procs | Stop-Process -Force -ErrorAction SilentlyContinue }"`
  Pop $0
  ; Fallback: stop the process listening on the NOVA loopback daemon port, but
  ; only if its executable path is inside $INSTDIR.
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$install = [System.IO.Path]::GetFullPath('$INSTDIR'); Get-NetTCPConnection -LocalPort ${NOVA_DAEMON_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $$p = Get-Process -Id $$_.OwningProcess -ErrorAction SilentlyContinue; if ($$p -and $$p.Path -and ([System.IO.Path]::GetFullPath($$p.Path)).StartsWith($$install, [System.StringComparison]::OrdinalIgnoreCase)) { Stop-Process -Id $$p.Id -PassThru -ErrorAction SilentlyContinue | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue; Stop-Process -Id $$p.Id -Force -ErrorAction SilentlyContinue } }"`
  Pop $0
  Sleep 500
!macroend

!macro NovaRemoveLegacyInstallArtifacts
  ; Remove obsolete engines/manifests that can conflict with the current
  ; in-process libcurl multi + yt-dlp + ffmpeg runtime model. Keep user data,
  ; downloads, and settings intact.
  Delete "$INSTDIR\aria2c.exe"
  Delete "$INSTDIR\aria2.conf"
  Delete "$INSTDIR\resources\bin\aria2c.exe"
  Delete "$INSTDIR\resources\aria2c.exe"
  RMDir /r "$INSTDIR\.wxt"
  RMDir /r "$INSTDIR\.output"
  RMDir /r "$INSTDIR\dist"
!macroend

!macro NovaPatchNativeMessagingManifest
  ; The manifest is generated at build time with a placeholder executable path.
  ; Patch it to the final install location after files are extracted.
  IfFileExists "${NOVA_NATIVE_MANIFEST}" 0 nova_skip_native_patch
    nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$manifest='${NOVA_NATIVE_MANIFEST}'; $$exe='${NOVA_APP_EXE}'; $$json = Get-Content -Raw -Path $$manifest | ConvertFrom-Json; $$json.path = $$exe; $$json | ConvertTo-Json -Depth 8 | Set-Content -Path $$manifest -Encoding ASCII"`
    Pop $0
  nova_skip_native_patch:
!macroend

!macro NovaRegisterNativeMessagingIfBundled
  ; Register Chrome/Edge/Firefox native hosts when the manifest is bundled.
  ; Chrome/Edge require allowed_origins to contain the final store/development
  ; extension IDs. Firefox uses allowed_extensions, which is stable in the
  ; extension manifest. Loopback transport remains available as fallback.
  IfFileExists "${NOVA_NATIVE_MANIFEST}" 0 nova_skip_native_manifest
    WriteRegStr SHCTX "Software\Mozilla\NativeMessagingHosts\${NOVA_NATIVE_HOST}" "" "${NOVA_NATIVE_MANIFEST}"
    WriteRegStr SHCTX "Software\Google\Chrome\NativeMessagingHosts\${NOVA_NATIVE_HOST}" "" "${NOVA_NATIVE_MANIFEST}"
    WriteRegStr SHCTX "Software\Microsoft\Edge\NativeMessagingHosts\${NOVA_NATIVE_HOST}" "" "${NOVA_NATIVE_MANIFEST}"
    WriteRegStr SHCTX "${NOVA_APP_KEY}" "NativeMessagingManifest" "${NOVA_NATIVE_MANIFEST}"
  nova_skip_native_manifest:
!macroend


!macro NovaCreateMaintenanceShortcuts
  CreateDirectory "$SMPROGRAMS\Nova Download Manager"
  IfFileExists "$INSTDIR\uninstall.exe" 0 nova_skip_uninstall_shortcut
    CreateShortCut "$SMPROGRAMS\Nova Download Manager\Uninstall NOVA.lnk" "$INSTDIR\uninstall.exe" "" "$INSTDIR\uninstall.exe" 0
  nova_skip_uninstall_shortcut:
!macroend

!macro NovaWriteInstallReceipt
  ; Small install receipt used for diagnostics and repair detection. It is not
  ; user app data and may be replaced by repair/upgrade installs.
  CreateDirectory "$INSTDIR"
  FileOpen $0 "$INSTDIR\nova-install-receipt.ini" w
  FileWrite $0 "[NOVA]$\r$\n"
  FileWrite $0 "Product=${NOVA_PRODUCT_NAME}$\r$\n"
  FileWrite $0 "InstallDir=$INSTDIR$\r$\n"
  FileWrite $0 "Mode=$1$\r$\n"
  FileWrite $0 "DaemonPort=${NOVA_DAEMON_PORT}$\r$\n"
  FileWrite $0 "NativeHost=${NOVA_NATIVE_HOST}$\r$\n"
  FileWrite $0 "NativeManifest=${NOVA_NATIVE_MANIFEST}$\r$\n"
  FileWrite $0 "BuildTimestamp=${__DATE__} ${__TIME__}$\r$\n"
  !if "${NOVA_BUILD_ID}" != ""
    FileWrite $0 "BuildId=${NOVA_BUILD_ID}$\r$\n"
  !endif
  !if "${NOVA_BUILD_COMMIT}" != ""
    FileWrite $0 "BuildCommit=${NOVA_BUILD_COMMIT}$\r$\n"
  !endif
  FileWrite $0 "ProductVersion=${VERSION}$\r$\n"
  FileWrite $0 "NsisVersion=${VERSION}$\r$\n"
  FileClose $0
!macroend

!macro NovaWriteWindowsIntegrationRegistry
  WriteRegStr SHCTX "${NOVA_APP_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr SHCTX "${NOVA_APP_KEY}" "DaemonUrl" "http://127.0.0.1:${NOVA_DAEMON_PORT}"
  WriteRegStr SHCTX "${NOVA_APP_KEY}" "NativeHost" "${NOVA_NATIVE_HOST}"
  WriteRegStr SHCTX "${NOVA_UNINSTALL_KEY}" "DisplayName" "${NOVA_PRODUCT_NAME}"
  WriteRegStr SHCTX "${NOVA_UNINSTALL_KEY}" "Publisher" "NOVA"
  WriteRegStr SHCTX "${NOVA_UNINSTALL_KEY}" "DisplayIcon" "${NOVA_APP_EXE}"
  WriteRegStr SHCTX "${NOVA_UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr SHCTX "${NOVA_UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr SHCTX "${NOVA_UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr SHCTX "${NOVA_UNINSTALL_KEY}" "ModifyPath" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD SHCTX "${NOVA_UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD SHCTX "${NOVA_UNINSTALL_KEY}" "NoRepair" 0
!macroend

!macro NovaUnregisterNativeMessaging
  DeleteRegKey SHCTX "Software\Google\Chrome\NativeMessagingHosts\${NOVA_NATIVE_HOST}"
  DeleteRegKey SHCTX "Software\Microsoft\Edge\NativeMessagingHosts\${NOVA_NATIVE_HOST}"
  DeleteRegKey SHCTX "Software\Mozilla\NativeMessagingHosts\${NOVA_NATIVE_HOST}"
!macroend

!macro NovaRemoveInstallDirLeftovers
  ; After NSIS removes files, clean the remaining installation directory. User
  ; app data is intentionally not removed here; Tauri exposes a separate
  ; uninstall app-data checkbox for that.
  Delete "$SMPROGRAMS\Nova Download Manager\Uninstall NOVA.lnk"
  RMDir /r "$INSTDIR"
  RMDir /r "$SMPROGRAMS\Nova Download Manager"
!macroend

!macro NovaCacheMaintenanceInstaller
  ; Cache the current installer so repairs can run offline without re-downloading.
  ; The cached copy lives under ProgramData and is replaced on each upgrade.
  StrCpy $0 "$PROGRAMDATA\NOVA\cache"
  CreateDirectory "$0"
  IfFileExists "$EXEDIR\${_FILE}" 0 nova_skip_cache
    CopyFiles "$EXEDIR\${_FILE}" "$0\installer.exe"
  nova_skip_cache:
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro NovaResolveInstallMode
  !insertmacro NovaStopOwnedProcesses
  !insertmacro NovaRemoveLegacyInstallArtifacts

  ; Handle /NOVA_REPAIR: force maintenance mode and set auto-close for repair
  ${GetOptions} $CMDLINE "/NOVA_REPAIR" $R0
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
    StrCpy $UpdateMode 1
    SetAutoClose true
  ${EndIf}

  ; Detect upgrade: if install mode was resolved as maintenance, check whether
  ; the existing version is older than this installer. If so, append /UPDATE
  ; so the uninstaller runs silently in the background before the new files
  ; are extracted.
  ${GetOptions} $CMDLINE "/UPDATE" $R0
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  ${If} $UpdateMode != 1
    IfFileExists "$INSTDIR\nova-install-receipt.ini" 0 nova_preinstall_no_upgrade
      ReadINIStr $R0 "$INSTDIR\nova-install-receipt.ini" "NOVA" "ProductVersion"
      ${If} $R0 != ""
        StrCpy $R1 $R0
        nsis_tauri_utils::SemverCompare "${VERSION}" $R0
        Pop $R0
        ${If} $R0 = 1
          StrCpy $UpdateMode 1
          DetailPrint "Upgrading from v$R1 to v${VERSION} ..."
        ${EndIf}
      ${EndIf}
    nova_preinstall_no_upgrade:
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\.nova-install-mode"
  !insertmacro NovaPatchNativeMessagingManifest
  !insertmacro NovaWriteInstallReceipt
  !insertmacro NovaRegisterNativeMessagingIfBundled
  !insertmacro NovaCreateMaintenanceShortcuts
  !insertmacro NovaWriteWindowsIntegrationRegistry
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro NovaStopOwnedProcesses
  !insertmacro NovaUnregisterNativeMessaging
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro NovaRemoveInstallDirLeftovers
  DeleteRegKey SHCTX "${NOVA_UNINSTALL_KEY}"
  DeleteRegKey SHCTX "${NOVA_APP_KEY}"
  DeleteRegKey /ifempty SHCTX "${NOVA_VENDOR_KEY}"
  DeleteRegKey HKCU "Software\com.nova.downloadmanager"
!macroend
