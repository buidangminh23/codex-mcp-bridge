param(
  [Parameter(Mandatory = $true)][string]$LiteralPath,
  [Parameter(Mandatory = $true)][ValidateSet('directory', 'file')][string]$Kind,
  [Parameter(Mandatory = $true)][ValidateSet('protect', 'assert')][string]$Mode
)
$ErrorActionPreference = 'Stop'
try {
  $item = Get-Item -LiteralPath $LiteralPath -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe path' }
  if (($Kind -eq 'directory') -ne [bool]$item.PSIsContainer) { throw 'Wrong path type' }
  if ($Mode -eq 'protect' -and $Kind -ne 'directory') { throw 'Invalid protection scope' }
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $trusted = @($currentSid.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
  $acl = Get-Acl -LiteralPath $LiteralPath
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($trusted -notcontains $owner) { throw 'Untrusted owner' }
  if ($Mode -eq 'protect') {
    $replacement = New-Object Security.AccessControl.DirectorySecurity
    $replacement.SetAccessRuleProtection($true, $false)
    foreach ($sidValue in $trusted) {
      $sid = New-Object Security.Principal.SecurityIdentifier($sidValue)
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
      $replacement.AddAccessRule($rule)
    }
    [IO.Directory]::SetAccessControl($LiteralPath, $replacement)
    $acl = Get-Acl -LiteralPath $LiteralPath
  }
  $ownerTrusted = $trusted -contains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $allowedOnly = $true
  $userFullControl = $false
  $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  foreach ($rule in $rules) {
    if ($trusted -notcontains $rule.IdentityReference.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { $allowedOnly = $false }
    if ($rule.IdentityReference.Value -eq $currentSid.Value -and $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0) { $userFullControl = $true }
  }
  $item = Get-Item -LiteralPath $LiteralPath -Force
  @{ ownerTrusted = $ownerTrusted; allowedPrincipalsOnly = $allowedOnly; currentUserFullControl = $userFullControl; protected = $acl.AreAccessRulesProtected; noReparse = (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0); kind = $Kind } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine('Private relay storage verification failed')
  exit 1
}
