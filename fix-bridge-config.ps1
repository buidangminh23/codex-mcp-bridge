#requires -Version 7
[CmdletBinding(SupportsShouldProcess)]
param(
    [string[]]$ConfigPath = @(
        (Join-Path $env:APPDATA 'Claude/claude_desktop_config.json'),
        (Join-Path $env:USERPROFILE '.claude.json')
    ),
    [scriptblock]$RunningProcesses = {
        Get-CimInstance Win32_Process -Filter "Name='claude.exe'" -ErrorAction Stop
    }
)

$ErrorActionPreference = 'Stop'
$supervisor = Join-Path $PSScriptRoot 'src/mcp-supervisor.mjs'
if (-not (Test-Path -LiteralPath $supervisor -PathType Leaf)) { throw "Bridge supervisor not found: $supervisor" }
$plans = @()
$found = 0
foreach ($file in $ConfigPath) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        Write-Warning "Configuration not found: $file"
        continue
    }
    $file = (Resolve-Path -LiteralPath $file).Path
    $original = [IO.File]::ReadAllText($file)
    $config = ConvertFrom-Json -InputObject $original -AsHashtable
    if ($config -isnot [System.Collections.IDictionary]) { throw "Invalid configuration: $file" }
    $before = ConvertTo-Json -InputObject $config -Depth 100 -Compress
    foreach ($name in @('codex-bridge', 'codex-bridge-desktop')) {
        if (-not $config.mcpServers -or -not $config.mcpServers.Contains($name)) { continue }
        $entry = $config.mcpServers[$name]
        if ($entry -isnot [System.Collections.IDictionary]) { throw "Invalid MCP entry ${name}: $file" }
        $found++
        $command = if ($entry.command) { Get-Command $entry.command -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }
        if (-not $command) { $command = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1 }
        $entry.command = $command.Source
        $entry.args = @($supervisor, 'index.mjs')
        if (-not $entry.Contains('env')) { $entry.env = @{} }
        if ($entry.env -isnot [System.Collections.IDictionary]) { throw "Invalid MCP environment ${name}: $file" }
        if ($entry.env.CODEX_BIN -and -not (Test-Path -LiteralPath $entry.env.CODEX_BIN -PathType Leaf)) {
            $platformUrl = ([uri](Join-Path $PSScriptRoot 'src/platform.mjs')).AbsoluteUri
            $resolved = & $command.Source --input-type=module -e "import { resolveCodexBin } from '$platformUrl'; console.log(resolveCodexBin());"
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "Unable to resolve Codex executable for $file" }
            $entry.env.CODEX_BIN = $resolved
        }
        if ($name -eq 'codex-bridge-desktop') { $entry.env.CODEX_BRIDGE_DESKTOP_TASKS = '1' }
        if ($entry.env.CODEX_BRIDGE_DESKTOP_TASKS -eq '1') { $entry.env.CODEX_BRIDGE_AUTOSTART = '0' }
    }
    $after = ConvertTo-Json -InputObject $config -Depth 100 -Compress
    if ($after -eq $before) {
        Write-Output "Unchanged: $file"
        continue
    }
    $plans += @{ File = $file; Original = $original; Content = (ConvertTo-Json -InputObject $config -Depth 100) + "`n" }
}
if ($found -eq 0) { throw 'No existing codex-bridge or codex-bridge-desktop entries found.' }
foreach ($plan in $plans) {
    if (-not $PSCmdlet.ShouldProcess($plan.File, 'Repair bridge launcher while preserving access policy')) { continue }
    if ($IsWindows -or $PSBoundParameters.ContainsKey('RunningProcesses')) {
        $desktopConfig = [IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Claude/claude_desktop_config.json'))
        $codeConfig = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.claude.json'))
        $targetConfig = [IO.Path]::GetFullPath($plan.File)
        if ($targetConfig -eq $desktopConfig -or $targetConfig -eq $codeConfig) {
            $processes = @(& $RunningProcesses)
            foreach ($process in $processes) {
                $executablePath = $process.ExecutablePath
                $unknown = [string]::IsNullOrWhiteSpace($executablePath)
                $code = $executablePath -match 'claude-code|anthropic\.claude-code'
                $desktop = -not $code -and $executablePath -match 'AnthropicClaude|WindowsApps[\\/]Claude_'
                if ($targetConfig -eq $desktopConfig -and ($unknown -or $desktop)) {
                    throw 'Close Claude Desktop before repairing its configuration; it may overwrite edits on exit.'
                }
                if ($targetConfig -eq $codeConfig -and ($unknown -or $code)) {
                    throw 'Close Claude Code before repairing ~/.claude.json; it rewrites the file on exit.'
                }
            }
        }
    }
    if ([IO.File]::ReadAllText($plan.File) -cne $plan.Original) { throw "Configuration changed during repair: $($plan.File)" }
    $suffix = [guid]::NewGuid().ToString('N')
    $temporary = "$($plan.File).tmp-$suffix"
    $backup = "$($plan.File).bak-$suffix"
    try {
        [IO.File]::WriteAllText($temporary, $plan.Content, [Text.UTF8Encoding]::new($false))
        $null = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($temporary)) -AsHashtable
        [IO.File]::Replace($temporary, $plan.File, $backup)
        if ([IO.File]::ReadAllText($plan.File) -cne $plan.Content) { throw "Configuration verification failed: $($plan.File)" }
        Write-Output "Repaired: $($plan.File) (backup: $backup)"
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
    }
}
Write-Output 'Reconnect repaired MCP clients, then verify bridge status and automatic reload.'
