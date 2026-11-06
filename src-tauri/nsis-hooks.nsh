!macro NSIS_HOOK_PREUNINSTALL
  ; App data is part of the uninstall contract; do not leave it behind even if
  ; the generated checkbox is left unchecked.
  StrCpy $DeleteAppDataCheckboxState 1
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Never wipe app data or credentials while handling an in-app update.
  ${If} $UpdateMode <> 1
    ; Remove the Windows Credential Manager entry created by the keyring backend.
    ExecWait '"$SYSDIR\cmdkey.exe" /delete:bilibili-session.BiliPocket'

    ; Remove Tauri app data, local data (WebView2), logs and registry leftovers.
    SetShellVarContext current
    RmDir /r "$APPDATA\com.bilipocket.desktop"
    RmDir /r "$LOCALAPPDATA\com.bilipocket.desktop"
    DeleteRegKey HKCU "Software\BiliPocket"
    DeleteRegKey HKCU "Software\com.bilipocket.desktop"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "BiliPocket"
  ${EndIf}
!macroend
