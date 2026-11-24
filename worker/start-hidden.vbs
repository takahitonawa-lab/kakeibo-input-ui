' Starts the receipt worker without showing a window (used at logon).
' The log goes to worker\worker.log next to this file.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Run "cmd /c node receipt-worker.mjs >> worker.log 2>&1", 0, False
