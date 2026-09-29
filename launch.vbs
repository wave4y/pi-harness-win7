Option Explicit
Dim fso, shell, root, node, script, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
node = fso.BuildPath(root, "runtime\node.exe")
script = fso.BuildPath(root, "dist\server.cjs")
If Not fso.FileExists(node) Then
  MsgBox "Missing runtime\node.exe. Please use the portable release package.", 16, "Pi Web"
  WScript.Quit 1
End If
shell.CurrentDirectory = root
command = Chr(34) & node & Chr(34) & " " & Chr(34) & script & Chr(34)
' Directly launch node.exe, with no CMD/PowerShell. Keep the console available to stop with Ctrl+C.
shell.Run command, 1, False
WScript.Sleep 1500
shell.Run "http://127.0.0.1:3080", 1, False
