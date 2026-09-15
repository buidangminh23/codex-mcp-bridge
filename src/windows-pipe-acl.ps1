param([Parameter(Mandatory)][string]$PipeName,[Parameter(Mandatory)][uint32]$ServerPid)
$ErrorActionPreference='Stop'
if($PipeName -notmatch '^LOCAL\\(?:codex-native-relay|codex-bridge|cc-msg)-[A-Za-z0-9_.-]+$'){throw 'Refusing a pipe outside the bridge-owned namespace.'}
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class BridgePipeAcl {
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentThread();
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool ImpersonateAnonymousToken(IntPtr thread);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool RevertToSelf();
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr sa,uint creation,uint flags,IntPtr template);
 public static int AttemptAnonymous(string name,uint access) {
  if(!ImpersonateAnonymousToken(GetCurrentThread())) throw new Win32Exception(Marshal.GetLastWin32Error());
  try {
   using(var handle=CreateFile(name,access,0,IntPtr.Zero,3,0,IntPtr.Zero)) {
    int error=Marshal.GetLastWin32Error();
    return handle.IsInvalid ? error : 0;
   }
  } finally {
   if(!RevertToSelf()) Environment.FailFast("Could not end anonymous pipe ACL verification.");
  }
 }
}
'@
$pipe=New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, [System.IO.Pipes.PipeAccessRights]::FullControl, [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::Identification, [System.IO.HandleInheritability]::None)
try {
 $pipe.Connect(3000)
 [uint32]$actualPid=0
 if(-not [BridgePipeAcl]::GetNamedPipeServerProcessId($pipe.SafePipeHandle,[ref]$actualPid) -or $actualPid -ne $ServerPid){throw 'Pipe server identity mismatch.'}
 $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
 $before=$pipe.GetAccessControl()
 if($before.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Pipe owner is not current user.'}
 $acl=New-Object System.IO.Pipes.PipeSecurity
 $acl.SetAccessRuleProtection($true,$false)
 $acl.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($sid,[System.IO.Pipes.PipeAccessRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow)))
 $pipe.SetAccessControl($acl)
 $after=$pipe.GetAccessControl(); $rules=@($after.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
 if(-not $after.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IsInherited -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].PipeAccessRights -ne [System.IO.Pipes.PipeAccessRights]::FullControl){throw 'Restricted DACL readback mismatch.'}
 $nativeName='\\.\pipe\'+$PipeName
 $readError=[BridgePipeAcl]::AttemptAnonymous($nativeName,[uint32]2147483648)
 $duplexError=[BridgePipeAcl]::AttemptAnonymous($nativeName,[uint32]3221225472)
 if($readError -ne 5 -or $duplexError -ne 5){throw "Anonymous pipe access was not denied: read=$readError duplex=$duplexError"}
 [pscustomobject]@{serverMatches=$true;ownerMatches=$true;protected=$true;aceCount=1;rights=[int]$rules[0].PipeAccessRights;anonymousDenied=$true;readError=$readError;duplexError=$duplexError}|ConvertTo-Json -Compress
} finally {$pipe.Dispose()}
