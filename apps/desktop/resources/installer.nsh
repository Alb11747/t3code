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
!macro customInstall
  ${if} ${isUpdated}
  ${andIf} ${isForceRun}
    HideWindow
    Exec '"$appExe" --updated'
    !insertmacro quitSuccess
  ${endIf}
!macroend
