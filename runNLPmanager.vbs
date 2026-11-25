Dim fso, shell, rootDir, appDir, logFile
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
rootDir = fso.GetParentFolderName(WScript.ScriptFullName)
appDir = fso.BuildPath(rootDir, "app")
logFile = fso.BuildPath(rootDir, "download.log")

' ---- 1. Download the new code from GitHub (github-download.js: only files that changed there) -------------------------
' --force: this copy is never edited, so the downloaded files always replace the local ones. A running NLP Manager is left alone until the download has succeeded.
Function ReadLog()
  Dim f
  ReadLog = ""
  If fso.FileExists(logFile) Then
    Set f = fso.OpenTextFile(logFile, 1)
    If Not f.AtEndOfStream Then ReadLog = f.ReadAll
    f.Close
  End If
End Function

Function Tail(text, count)
  Dim lines, i, first, out
  lines = Split(Replace(text, vbCr, ""), vbLf)
  first = UBound(lines) - count + 1
  If first < 0 Then first = 0
  For i = first To UBound(lines)
    If Len(Trim(lines(i))) > 0 Then out = out & lines(i) & vbCrLf
  Next
  Tail = out
End Function

If MsgBox("Download the new code from GitHub and restart NLP Manager. This can take a few minutes." & vbCrLf & vbCrLf & "OK = download   |   Cancel = do nothing", vbOKCancel + vbInformation, "NLP Manager") = vbCancel Then WScript.Quit 0

Dim code, log
code = shell.Run("cmd /c cd /d """ & rootDir & """ && node github-download.js --force > """ & logFile & """ 2>&1", 0, True)
log = ReadLog()
If code <> 0 Or InStr(log, "FAILED:") > 0 Then
  MsgBox "The download from GitHub did not succeed, so NLP Manager was NOT restarted (a running copy was left as it is)." & vbCrLf & vbCrLf & Tail(log, 8) & vbCrLf & "Full log: " & logFile, vbExclamation, "NLP Manager"
  WScript.Quit 1
End If

' New dependencies?
If InStr(log, "app/package.json") > 0 Then
  shell.Run "cmd /c cd /d """ & appDir & """ && npm install --legacy-peer-deps > """ & fso.BuildPath(rootDir, "npm-install.log") & """ 2>&1", 0, True
End If

' ---- 1b. The code is downloaded. Start the app now? Cancel = keep the code, leave a running NLP Manager as it is and do not start one.
If MsgBox(DownloadSummary(log) & vbCrLf & vbCrLf & "OK = (re)start NLP Manager now; a running copy is stopped first." & vbCrLf & "Cancel = keep the downloaded code, do not start the app.", vbOKCancel + vbInformation, "NLP Manager") = vbCancel Then WScript.Quit 0

' ---- 2. Stop a running NLP Manager ------------------------------------------------------------------------------------
' Only its own processes are touched:
'   - processes that run from this app folder (Electron and its helpers, Vite, concurrently, cross-env),
'   - everything those processes started (child processes, the embedded PostgreSQL),
'   - the cmd / npm wrappers directly above "concurrently" (npm run dev), up to three levels.
' Other node.js applications on this computer do not match any of these and are left alone.
' The embedded PostgreSQL is cleaned up by the app itself at startup.
Function StopRunning()
  Dim wmi, p, key, parentOf, nameOf, cmdOf, kill, id, changed, k, up, n
  key = LCase(appDir) & "\"
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  Set parentOf = CreateObject("Scripting.Dictionary")
  Set nameOf = CreateObject("Scripting.Dictionary")
  Set cmdOf = CreateObject("Scripting.Dictionary")
  Set kill = CreateObject("Scripting.Dictionary")
  For Each p In wmi.ExecQuery("SELECT ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine FROM Win32_Process")
    id = CLng(p.ProcessId)
    parentOf(id) = CLng(p.ParentProcessId)
    nameOf(id) = LCase(p.Name)
    cmdOf(id) = ""
    If Not IsNull(p.CommandLine) Then cmdOf(id) = LCase(p.CommandLine)
    If Not IsNull(p.ExecutablePath) Then
      If InStr(LCase(p.ExecutablePath), key) > 0 Then kill(id) = True
    End If
    If InStr(cmdOf(id), key) > 0 And (nameOf(id) = "node.exe" Or nameOf(id) = "electron.exe" Or nameOf(id) = "cmd.exe") Then kill(id) = True
  Next

  ' the wrappers above concurrently
  For Each k In kill.Keys
    If InStr(cmdOf(k), "concurrently") > 0 And nameOf(k) = "node.exe" Then
      up = k
      For n = 1 To 3
        If Not parentOf.Exists(up) Then Exit For
        up = parentOf(up)
        If Not nameOf.Exists(up) Then Exit For
        If nameOf(up) = "cmd.exe" Or nameOf(up) = "node.exe" Then kill(up) = True Else Exit For
      Next
    End If
  Next

  ' children of everything marked
  Do
    changed = False
    For Each id In parentOf.Keys
      If Not kill.Exists(id) Then
        If kill.Exists(parentOf(id)) Then kill(id) = True: changed = True
      End If
    Next
  Loop While changed

  n = 0
  For Each p In wmi.ExecQuery("SELECT ProcessId FROM Win32_Process")
    If kill.Exists(CLng(p.ProcessId)) And CLng(p.ProcessId) <> 0 Then
      On Error Resume Next
      p.Terminate()
      If Err.Number = 0 Then n = n + 1
      Err.Clear
      On Error GoTo 0
    End If
  Next
  StopRunning = n
End Function

Dim stopped
stopped = StopRunning()
If stopped > 0 Then WScript.Sleep 3000

' ---- 3. Start the new code ----------------------------------------------------------------------------------------------
If stopped > 0 Then
  MsgBox "The running NLP Manager was stopped. Starting NLP Manager - please wait approximately 1 minute for the application to load." & vbCrLf & vbCrLf & "Click OK to continue.", vbInformation, "NLP Manager"
Else
  MsgBox "Starting NLP Manager - please wait approximately 1 minute for the application to load." & vbCrLf & vbCrLf & "Click OK to continue.", vbInformation, "NLP Manager"
End If
shell.Run "cmd /c cd /d """ & appDir & """ && npm run start:built", 0, False

' What github-download.js reported: "new      <path>" / "updated  <path>" for every file it fetched. -> text for the message box
Function DownloadSummary(text)
  Dim lines, i, s, nNew, nUpd, names, shown, extra
  lines = Split(Replace(text, vbCr, ""), vbLf)
  nNew = 0: nUpd = 0: shown = 0
  For i = 0 To UBound(lines)
    s = Trim(lines(i))
    If Left(s, 4) = "new " Or Left(s, 8) = "updated " Then
      If Left(s, 4) = "new " Then nNew = nNew + 1 Else nUpd = nUpd + 1
      If shown < 15 Then names = names & "   " & s & vbCrLf: shown = shown + 1
    End If
  Next
  If nNew + nUpd = 0 Then
    DownloadSummary = "Nothing new on GitHub: no file was downloaded, the code was already up to date."
    Exit Function
  End If
  DownloadSummary = (nNew + nUpd) & " file" & IIf2(nNew + nUpd = 1, "", "s") & " downloaded from GitHub (" & nNew & " new, " & nUpd & " updated):" & vbCrLf & names
  extra = nNew + nUpd - shown
  If extra > 0 Then DownloadSummary = DownloadSummary & "   ... and " & extra & " more (full list: " & logFile & ")" & vbCrLf
End Function

Function IIf2(c, a, b)
  If c Then IIf2 = a Else IIf2 = b
End Function
