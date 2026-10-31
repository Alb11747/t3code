; electron-builder includes this file in the NSIS installer automatically
; (directories.buildResources/installer.nsh).

; After an auto-update, electron-builder's StartApp relaunches through
; StdUtils.ExecShellAsUser, which always drops elevation, so a T3 Code that the
; user ran as administrator came back without it. The per-user installer
; inherits the elevation of the app that spawned it, so starting the app
; directly with Exec restores the level it had before the update, elevated or
; not. Exception: if electron-updater cannot spawn the installer and falls back
; to elevate.exe, the installer and therefore the app run elevated.
; customInstall is the last hook before StartApp; quitting here skips it and
; leaves only the installer's own success exit.
!include "StrFunc.nsh"
!ifdef BUILD_UNINSTALLER
  ${UnStrRep}
  !define T3StrRep '${UnStrRep}'
!else
  ${StrRep}
  !define T3StrRep '${StrRep}'
!endif

!macro customAppRunningMessages
  Push $0
  Push $1
  ${If} $IsPowerShellAvailable == 0
    System::Call 'kernel32::SetEnvironmentVariable(t "T3CODE_INSTALL_DIR", t "$INSTDIR")'
    nsExec::ExecToStack `"$PowerShellPath" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and [IO.Path]::GetDirectoryName($$_.ExecutablePath) -eq $$env:T3CODE_INSTALL_DIR } | ForEach-Object { [IO.Path]::GetFileNameWithoutExtension($$_.ExecutablePath) } | Where-Object { $$_ -in 'T3 Code (Alpha)', 'T3 Code (Beta)', 'T3 Code (Nightly)' } | Select-Object -First 1 | ForEach-Object { [Console]::Write($$_) }"`
    Pop $0
    Pop $1
    System::Call 'kernel32::SetEnvironmentVariable(t "T3CODE_INSTALL_DIR", p 0)'
    ${If} $0 == 0
      ${If} $1 == "T3 Code (Alpha)"
      ${OrIf} $1 == "T3 Code (Beta)"
      ${OrIf} $1 == "T3 Code (Nightly)"
        ${T3StrRep} $appRunningMessage $appRunningMessage "${PRODUCT_NAME}" $1
        ${T3StrRep} $appClosingMessage $appClosingMessage "${PRODUCT_NAME}" $1
        ${T3StrRep} $appCannotBeClosedMessage $appCannotBeClosedMessage "${PRODUCT_NAME}" $1
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${IfNot} ${FileExists} "$newStartMenuLink"
      !insertmacro createMenuDirectory
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
  !endif
  ${if} ${isUpdated}
  ${andIf} ${isForceRun}
    HideWindow
    Exec '"$appExe" --updated'
    !insertmacro quitSuccess
  ${endIf}
!macroend
