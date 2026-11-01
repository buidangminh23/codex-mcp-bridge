Option Explicit
If WScript.Arguments.Count <> 3 Then WScript.Quit 2
Dim relayShell, relayEnvironment, relayNode, relayService
Set relayShell = CreateObject("WScript.Shell")
Set relayEnvironment = relayShell.Environment("PROCESS")
relayNode = WScript.Arguments(0)
relayService = WScript.Arguments(1)
If InStr(relayNode, Chr(34)) > 0 Or InStr(relayNode, "%") > 0 Then WScript.Quit 2
If InStr(relayService, Chr(34)) > 0 Or InStr(relayService, "%") > 0 Then WScript.Quit 2
relayEnvironment("AGENT_RELAY_DIRECTORY") = WScript.Arguments(2)
WScript.Quit relayShell.Run(Chr(34) & relayNode & Chr(34) & " " & Chr(34) & relayService & Chr(34), 0, True)
