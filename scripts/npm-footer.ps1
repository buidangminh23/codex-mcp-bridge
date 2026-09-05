if ($MyInvocation.InvocationName -eq '.') {
    Set-Alias -Name npm -Value $PSCommandPath -Scope Global
    return
}

$npmArguments = @($args)
$nativeNpm = Get-Command npm -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nativeNpm) {
    throw [System.Management.Automation.CommandNotFoundException]::new('The npm executable was not found on PATH.')
}

$matchesInstall = $npmArguments.Count -ge 3 -and $npmArguments[0] -cin @('install', 'i')
$isGlobal = $false
$targetCount = 0
$prefixArguments = @()
$dryRunOverride = $null
for ($argumentIndex = 1; $matchesInstall -and $argumentIndex -lt $npmArguments.Count; $argumentIndex++) {
    $argument = [string]$npmArguments[$argumentIndex]
    if ($argument -cin @('-g', '--global', '--global=true')) {
        $isGlobal = $true
    } elseif ($argument -cmatch '^@minhspark/codex-mcp-bridge(?:@[^\s]+)?$') {
        $targetCount++
    } elseif ($argument -cin @('--no-fund', '--no-audit', '--force', '--ignore-scripts', '--foreground-scripts')) {
        continue
    } elseif ($argument -cin @('--dry-run', '--dry-run=true')) {
        $dryRunOverride = $true
    } elseif ($argument -cin @('--no-dry-run', '--dry-run=false')) {
        $dryRunOverride = $false
    } elseif ($argument -ceq '--prefix') {
        $argumentIndex++
        if ($argumentIndex -ge $npmArguments.Count -or -not $npmArguments[$argumentIndex] -or [string]$npmArguments[$argumentIndex] -clike '-*' -or $prefixArguments.Count) {
            $matchesInstall = $false
        } else {
            $prefixArguments = @('--prefix', [string]$npmArguments[$argumentIndex])
        }
    } elseif ($argument -cmatch '^--prefix=(.+)$' -and -not $prefixArguments.Count) {
        $prefixArguments = @($argument)
    } else {
        $matchesInstall = $false
    }
}

if (-not $matchesInstall -or -not $isGlobal -or $targetCount -ne 1) {
    $global:LASTEXITCODE = 0
    & $nativeNpm @npmArguments
    exit $LASTEXITCODE
}

$PSNativeCommandUseErrorActionPreference = $false
$readVersion = {
    param([string]$PackageRoot)
    try {
        $metadataPath = Join-Path $PackageRoot '@minhspark/codex-mcp-bridge/package.json'
        if (-not [System.IO.File]::Exists($metadataPath)) {
            return @{ Status = 'missing'; Version = $null }
        }
        $metadata = [System.IO.File]::ReadAllText($metadataPath) | ConvertFrom-Json -ErrorAction Stop
        if ($metadata.name -cne '@minhspark/codex-mcp-bridge' -or $metadata.version -isnot [string] -or $metadata.version -cnotmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
            return @{ Status = 'unknown'; Version = $null }
        }
        return @{ Status = 'known'; Version = $metadata.version }
    } catch {
        return @{ Status = 'unknown'; Version = $null }
    }
}
$readRoot = {
    try {
        $global:LASTEXITCODE = 0
        $rootOutput = @(& $nativeNpm root --global @prefixArguments 2>$null)
        if ($LASTEXITCODE -ne 0 -or $rootOutput.Count -ne 1) {
            return $null
        }
        $packageRoot = ([string]$rootOutput[0]).Trim()
        if (-not $packageRoot -or -not [System.IO.Path]::IsPathRooted($packageRoot)) {
            return $null
        }
        return $packageRoot
    } catch {
        return $null
    }
}

$dryRun = $dryRunOverride
if ($null -eq $dryRun) {
    try {
        $global:LASTEXITCODE = 0
        $configOutput = @(& $nativeNpm config get dry-run --global @prefixArguments 2>$null)
        if ($LASTEXITCODE -eq 0 -and $configOutput.Count -eq 1) {
            $configValue = ([string]$configOutput[0]).Trim()
            if ($configValue -ceq 'true') {
                $dryRun = $true
            } elseif ($configValue -ceq 'false') {
                $dryRun = $false
            }
        }
    } catch {
        $dryRun = $null
    }
}

$beforeRoot = & $readRoot
$before = @{ Status = 'unknown'; Version = $null }
if ($beforeRoot) {
    $before = & $readVersion $beforeRoot
}

$global:LASTEXITCODE = 0
& $nativeNpm @npmArguments
$npmExitCode = $LASTEXITCODE
try {
    if ($npmExitCode -ne 0) {
        Write-Host "Failed to install: @minhspark/codex-mcp-bridge (exit code $npmExitCode). See npm error above."
        exit $npmExitCode
    }
    if ($null -eq $dryRun) {
        Write-Host 'Warning: npm completed, but installation mode could not be verified.'
        exit $npmExitCode
    }
    if ($dryRun) {
        Write-Host 'Dry run completed: @minhspark/codex-mcp-bridge (no changes applied).'
        exit $npmExitCode
    }
    $afterRoot = & $readRoot
    $after = @{ Status = 'unknown'; Version = $null }
    if ($afterRoot) {
        $after = & $readVersion $afterRoot
    }
    if ($after.Status -ne 'known' -or $before.Status -eq 'unknown' -or $beforeRoot -cne $afterRoot) {
        Write-Host 'Warning: npm completed, but the installed @minhspark/codex-mcp-bridge version could not be verified.'
    } elseif ($before.Status -eq 'missing') {
        Write-Host "Successfully installed: @minhspark/codex-mcp-bridge v$($after.Version)"
    } elseif ($before.Version -ceq $after.Version) {
        Write-Host "Already up to date: @minhspark/codex-mcp-bridge v$($after.Version)"
    } else {
        Write-Host "Successfully updated: @minhspark/codex-mcp-bridge v$($before.Version) -> v$($after.Version)"
    }
} finally {
    $global:LASTEXITCODE = $npmExitCode
}
exit $npmExitCode
