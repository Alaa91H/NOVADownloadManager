Unicode true

!include "MUI2.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "2.4.49-alpha"
!endif
!ifndef APP_FILE_VERSION
  !define APP_FILE_VERSION "2.4.49.0"
!endif
!ifndef APP_ARCH
  !define APP_ARCH "x64"
!endif
!ifndef APP_SOURCE_DIR
  !define APP_SOURCE_DIR "preview\NOVA-Native-Windows-${APP_ARCH}"
!endif

!define PRODUCT_NAME "NOVA Download Manager"
!define PRODUCT_PUBLISHER "Alaa91H"
!define PRODUCT_URL "https://github.com/Alaa91H/NOVADownloadManager"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\NOVA Download Manager"

Name "${PRODUCT_NAME}"
Caption "${PRODUCT_NAME} Setup"
OutFile "dist\NOVA-Download-Manager-Setup-${APP_VERSION}-${APP_ARCH}.exe"
InstallDir "$LOCALAPPDATA\Programs\NOVA Download Manager"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
ShowInstDetails show
ShowUnInstDetails show
BrandingText "NOVA Download Manager"

VIProductVersion "${APP_FILE_VERSION}"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileDescription" "NOVA Download Manager Windows Setup"
VIAddVersionKey "CompanyName" "${PRODUCT_PUBLISHER}"
VIAddVersionKey "LegalCopyright" "Copyright NOVA Download Manager contributors"

!define MUI_ABORTWARNING
!define MUI_ICON "desktop-native\resources\icons\icon.ico"
!define MUI_UNICON "desktop-native\resources\icons\icon.ico"
!define MUI_STARTMENUPAGE_DEFAULTFOLDER "NOVA Download Manager"
!define MUI_STARTMENUPAGE_REGISTRY_ROOT HKCU
!define MUI_STARTMENUPAGE_REGISTRY_KEY "${UNINSTALL_KEY}"
!define MUI_STARTMENUPAGE_REGISTRY_VALUENAME "StartMenuFolder"
!define MUI_FINISHPAGE_RUN "$INSTDIR\bin\nova-native.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch NOVA Download Manager"

Var StartMenuFolder

Function .onInit
  SetRegView 64
FunctionEnd

Function un.onInit
  SetRegView 64
FunctionEnd

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_STARTMENU Application $StartMenuFolder
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "NOVA Download Manager" SEC_APPLICATION
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /r "${APP_SOURCE_DIR}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$"$INSTDIR\Uninstall.exe$"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\bin\nova-native.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "URLInfoAbout" "${PRODUCT_URL}"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1

  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    CreateDirectory "$SMPROGRAMS\$StartMenuFolder"
    CreateShortCut "$SMPROGRAMS\$StartMenuFolder\NOVA Download Manager.lnk" "$INSTDIR\bin\nova-native.exe"
    CreateShortCut "$SMPROGRAMS\$StartMenuFolder\Uninstall NOVA Download Manager.lnk" "$INSTDIR\Uninstall.exe"
  !insertmacro MUI_STARTMENU_WRITE_END
SectionEnd

Section /o "Create a desktop shortcut" SEC_DESKTOP
  CreateShortCut "$DESKTOP\NOVA Download Manager.lnk" "$INSTDIR\bin\nova-native.exe"
SectionEnd

Section "Uninstall"
  !insertmacro MUI_STARTMENU_GETFOLDER Application $StartMenuFolder
  Delete "$DESKTOP\NOVA Download Manager.lnk"
  Delete "$SMPROGRAMS\$StartMenuFolder\NOVA Download Manager.lnk"
  Delete "$SMPROGRAMS\$StartMenuFolder\Uninstall NOVA Download Manager.lnk"
  RMDir "$SMPROGRAMS\$StartMenuFolder"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  RMDir /r "$INSTDIR"
SectionEnd
