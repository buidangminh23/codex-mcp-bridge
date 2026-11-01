param(
  [Parameter(Mandatory = $true)][string]$LiteralPath,
  [Parameter(Mandatory = $true)][ValidateSet('directory', 'file')][string]$Kind,
  [Parameter(Mandatory = $true)][ValidateSet('protect', 'assert', 'batch')][string]$Mode
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
function Get-PrivateStorageState([string]$EntryPath, [string]$EntryKind, [bool]$Protect) {
  $item = Get-Item -LiteralPath $EntryPath -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe path' }
  if (($EntryKind -eq 'directory') -ne [bool]$item.PSIsContainer) { throw 'Wrong path type' }
  if ($Protect -and $EntryKind -ne 'directory') { throw 'Invalid protection scope' }
  $acl = Get-Acl -LiteralPath $EntryPath
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($trusted -notcontains $owner) { throw 'Untrusted owner' }
  if ($Protect) {
    $replacement = New-Object Security.AccessControl.DirectorySecurity
    $replacement.SetAccessRuleProtection($true, $false)
    foreach ($sidValue in $trusted) {
      $sid = New-Object Security.Principal.SecurityIdentifier($sidValue)
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
      $replacement.AddAccessRule($rule)
    }
    [IO.Directory]::SetAccessControl($EntryPath, $replacement)
    $acl = Get-Acl -LiteralPath $EntryPath
  }
  $ownerTrusted = $trusted -contains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $allowedOnly = $true
  $userFullControl = $false
  $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  foreach ($rule in $rules) {
    if ($trusted -notcontains $rule.IdentityReference.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { $allowedOnly = $false }
    if ($rule.IdentityReference.Value -eq $currentSid.Value -and $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) { $userFullControl = $true }
  }
  $item = Get-Item -LiteralPath $EntryPath -Force
  return @{ ownerTrusted = $ownerTrusted; allowedPrincipalsOnly = $allowedOnly; currentUserFullControl = $userFullControl; protected = $acl.AreAccessRulesProtected; noReparse = (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0); kind = $EntryKind }
}
try {
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $trusted = @($currentSid.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
  if ($Mode -eq 'batch') {
    if ($Kind -ne 'directory') { throw 'Invalid batch scope' }
    $encoded = [Console]::In.ReadToEnd()
    if ($encoded.Length -gt 1048576) { throw 'Batch limit exceeded' }
    $request = ConvertFrom-Json -InputObject $encoded
    if ($request.files -isnot [Array] -or $request.files.Count -gt 1024) { throw 'Invalid batch' }
    $directoryState = Get-PrivateStorageState $LiteralPath 'directory' $false
    if (-not ($directoryState.ownerTrusted -and $directoryState.allowedPrincipalsOnly -and $directoryState.currentUserFullControl -and $directoryState.protected -and $directoryState.noReparse)) { throw 'Unsafe directory' }
    $results = New-Object 'System.Collections.Generic.List[object]'
    foreach ($entryName in $request.files) {
      if ($entryName -isnot [string] -or $entryName.Length -eq 0 -or $entryName -match '[\\/:]' -or $entryName -eq '.' -or $entryName -eq '..') { throw 'Invalid batch path' }
      $entryPath = [IO.Path]::Combine($LiteralPath, $entryName)
      $entryState = Get-PrivateStorageState $entryPath 'file' $false
      $results.Add(@{ name = $entryName; state = $entryState })
    }
    @{ directory = $directoryState; files = @($results.ToArray()) } | ConvertTo-Json -Compress -Depth 6
  } else {
    Get-PrivateStorageState $LiteralPath $Kind ($Mode -eq 'protect') | ConvertTo-Json -Compress
  }
} catch {
  [Console]::Error.WriteLine('Private relay storage verification failed')
  exit 1
}
