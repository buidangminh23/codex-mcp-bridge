param(
    [Parameter(Mandatory = $true)][string]$PayloadBase64,
    [ValidateSet('Inspect', 'SelectFolder', 'Submit', 'Trust')][string]$Action = 'Inspect',
    [int]$WaitMilliseconds = 8000,
    [long]$ExpectedWindowId = 0
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64)) | ConvertFrom-Json
$deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(0, [Math]::Min(8000, $WaitMilliseconds)))
$invocationStarted = $false

function Finish([string]$Status, [string]$Reason, $Snapshot = $null) {
    $result = @{ status = $Status; reason = $Reason }
    if ($null -ne $Snapshot) { $result.snapshot = $Snapshot }
    $result | ConvertTo-Json -Depth 8 -Compress
    exit 0
}

function Descendants($Element) {
    return $Element.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
}

function Dialogs($Element) {
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        try {
            @(Descendants $Element | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window -or $_.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsDialogProperty) -eq $true })
            return
        } catch {
            if ($attempt -eq 2) { throw }
            Start-Sleep -Milliseconds 150
        }
    }
}

function TextValue($Element) {
    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        return ([System.Windows.Automation.ValuePattern]$pattern).Current.Value
    }
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
        return ([System.Windows.Automation.TextPattern]$pattern).DocumentRange.GetText(-1)
    }
    return $null
}

function IsInstalledDesktop($Process) {
    try {
        $exe = Get-Item -LiteralPath $Process.Path
        if ($exe.VersionInfo.ProductName -ne 'Claude' -or $exe.VersionInfo.CompanyName -ne 'Anthropic') { return $false }
        $localRoot = Join-Path $env:LOCALAPPDATA 'AnthropicClaude'
        $root = [IO.Path]::GetFullPath($localRoot).TrimEnd('\') + '\'
        if ($exe.FullName.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and $exe.Directory.Name -match '^app-\d+(\.\d+)+$' -and $exe.Name -ieq 'claude.exe') { return $true }
        foreach ($package in @(Get-AppxPackage -Name '*Claude*' -ErrorAction SilentlyContinue)) {
            if ($package.InstallLocation -and $exe.FullName.StartsWith($package.InstallLocation.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
    } catch {}
    return $false
}

function PathEqual([string]$First, [string]$Second) {
    try {
        if ($First -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)') { return $false }
        return [IO.Path]::GetFullPath($First).TrimEnd('\').Equals([IO.Path]::GetFullPath($Second).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function PromptEqual([string]$First, [string]$Second) {
    $firstLines = @($First.Replace("`r`n", "`n").Split("`n") | Where-Object { $_ -cne '' })
    $secondLines = @($Second.Replace("`r`n", "`n").Split("`n") | Where-Object { $_ -cne '' })
    return ($firstLines -join "`n") -ceq ($secondLines -join "`n")
}

function SelectedPaths($Folder, $Root) {
    $expander = [System.Windows.Automation.ExpandCollapsePattern]$Folder.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    try {
        if ($expander.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) { $expander.Expand() }
        Start-Sleep -Milliseconds 150
        $menus = @(Descendants $Root | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Menu -and $_.Current.Name -eq $Folder.Current.Name -and -not $_.Current.IsOffscreen })
        if ($menus.Count -ne 1) { throw 'Folder menu not verified' }
        foreach ($radio in @(Descendants $menus[0] | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::RadioButton })) {
            $selection = [System.Windows.Automation.SelectionItemPattern]$radio.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
            if ($selection.Current.IsSelected) { $radio.Current.HelpText }
        }
    } finally {
        if ($expander.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { $expander.Collapse() }
        Start-Sleep -Milliseconds 250
    }
}

try {
    do {
        $processes = @(Get-Process -Name Claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and (IsInstalledDesktop $_) })
        if ($processes.Count -ne 1) { Finish 'blocked' 'desktop_window_ambiguous_or_missing' }
        $process = $processes[0]
        $windowId = $process.MainWindowHandle.ToInt64()
        if ($ExpectedWindowId -ne 0 -and $ExpectedWindowId -ne $windowId) { Finish 'blocked' 'desktop_window_changed' }
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
        $elements = Descendants $root
        $dialogs = @(Dialogs $root)
        if ($Action -eq 'Trust') {
            if ($dialogs.Count -gt 0) {
                if ($dialogs.Count -ne 1 -or $dialogs[0].Current.Name -cne 'Trust this workspace?') { Finish 'blocked' 'workspace_trust_dialog_not_verified' }
                $trustElements = Descendants $dialogs[0]
                $trustPaths = @($trustElements | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and (PathEqual $_.Current.Name $request.cwd) })
                $trustButtons = @($trustElements | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -ceq 'Trust workspace' -and $_.Current.IsEnabled -and -not $_.Current.IsOffscreen })
                if ($trustPaths.Count -ne 1 -or $trustButtons.Count -ne 1) { Finish 'blocked' 'workspace_trust_path_mismatch_or_ambiguous' }
                $trustInvoke = $null
                if (-not $trustButtons[0].TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$trustInvoke)) { Finish 'blocked' 'workspace_trust_button_unavailable' }
                $invocationStarted = $true
                ([System.Windows.Automation.InvokePattern]$trustInvoke).Invoke()
                do {
                    Start-Sleep -Milliseconds 150
                    $remainingTrust = @(Descendants $root | Where-Object { $_.Current.Name -ceq 'Trust this workspace?' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window })
                    if ($remainingTrust.Count -eq 0) { Finish 'trusted' 'exact_native_workspace_trust_confirmed' }
                } while ([DateTime]::UtcNow -lt $deadline)
                Finish 'uncertain' 'native_workspace_trust_outcome_unknown'
            }
        }
        if ($dialogs.Count -gt 0) { Finish 'blocked' 'desktop_dialog_requires_attention' }
        $composers = @($elements | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and $_.Current.Name -eq 'Prompt' -and -not $_.Current.IsOffscreen })
        if ($composers.Count -gt 1) { Finish 'blocked' 'composer_ambiguous_or_missing' }
        if ($composers.Count -eq 1 -and (PromptEqual (TextValue $composers[0]) $request.prompt)) { break }
        if ([DateTime]::UtcNow -ge $deadline) { Finish 'blocked' 'composer_prompt_mismatch' }
        Start-Sleep -Milliseconds 150
    } while ($true)

    $codeControls = @($elements | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::RadioButton -and $_.Current.Name -eq 'Code' -and -not $_.Current.IsOffscreen })
    if ($codeControls.Count -ne 1) { Finish 'blocked' 'code_mode_not_selected' }
    $codeSelected = ([System.Windows.Automation.SelectionItemPattern]$codeControls[0].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).Current.IsSelected
    if (-not $codeSelected) { Finish 'blocked' 'code_mode_not_selected' }
    $pane = $composers[0]
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    for ($level = 0; $level -lt 12; $level++) {
        $pane = $walker.GetParent($pane)
        if ($null -eq $pane) { Finish 'blocked' 'composer_scope_unavailable' }
        if ($pane.Current.ClassName -match '(?:^|\s)dframe-pane-primary(?:\s|$)') { break }
    }
    if ($pane.Current.ClassName -notmatch '(?:^|\s)dframe-pane-primary(?:\s|$)') { Finish 'blocked' 'composer_scope_unavailable' }
    $scope = Descendants $pane
    $pillButtons = @($scope | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.ClassName -like '*pill-h*' -and -not $_.Current.IsOffscreen })
    $localMode = @($pillButtons | Where-Object { $_.Current.Name -eq 'Local' }).Count -eq 1
    $folders = @($pillButtons | Where-Object { $_.Current.Name -notin @('Local', 'Add another folder') })
    if (-not $localMode -or $folders.Count -ne 1) { Finish 'blocked' 'project_folder_ambiguous_or_remote' }
    $worktrees = @($scope | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::CheckBox -and $_.Current.Name -eq 'worktree' })
    $worktreeEnabled = $false
    if ($worktrees.Count -gt 1) { Finish 'blocked' 'original_project_folder_not_verified' }
    if ($worktrees.Count -eq 1) { $worktreeEnabled = ([System.Windows.Automation.TogglePattern]$worktrees[0].GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)).Current.ToggleState -ne [System.Windows.Automation.ToggleState]::Off }
    if ($worktreeEnabled) { Finish 'blocked' 'original_project_folder_not_verified' }

    $folder = $folders[0]
    $paths = @(SelectedPaths $folder $root)
    if ($paths.Count -ne 1 -or -not (PathEqual $paths[0] $request.cwd)) { Finish 'blocked' 'selected_project_path_mismatch' }
    $scope = Descendants $pane
    $sends = @($scope | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -eq 'Send' -and -not $_.Current.IsOffscreen })
    if ($sends.Count -ne 1 -or -not $sends[0].Current.IsEnabled) { Finish 'blocked' 'send_button_ambiguous_disabled_or_unavailable' }
    $invoke = $null
    if (-not $sends[0].TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) { Finish 'blocked' 'send_button_ambiguous_disabled_or_unavailable' }
    $currentPaths = @(SelectedPaths $folder $root)
    if ($currentPaths.Count -ne 1 -or -not (PathEqual $currentPaths[0] $request.cwd) -or -not (PromptEqual (TextValue $composers[0]) $request.prompt)) { Finish 'blocked' 'composer_changed_before_submission' }
    $currentDialogs = @(Dialogs $root)
    if ($currentDialogs.Count -gt 0) { Finish 'blocked' 'desktop_dialog_requires_attention' }
    if (-not ([System.Windows.Automation.SelectionItemPattern]$codeControls[0].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).Current.IsSelected) { Finish 'blocked' 'code_mode_not_selected' }
    if ($worktrees.Count -eq 1 -and ([System.Windows.Automation.TogglePattern]$worktrees[0].GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)).Current.ToggleState -ne [System.Windows.Automation.ToggleState]::Off) { Finish 'blocked' 'original_project_folder_not_verified' }
    $snapshot = @{
        windows = @(@{ id = $windowId; installedDesktop = $true })
        dialogs = @()
        codeSelected = $true
        composers = @(@{ text = (TextValue $composers[0]) })
        folderCount = $folders.Count
        localMode = $localMode
        worktreeEnabled = $worktreeEnabled
        selectedFolderPaths = @($paths)
        sendButtons = @(@{ enabled = $true; invokable = $true })
    }
    if ($Action -eq 'Inspect') { Finish 'ready' 'exact_composer_and_project_verified' $snapshot }
    if ($Action -eq 'Trust') { Finish 'absent' 'exact_composer_and_project_verified' $snapshot }
    if ($Action -eq 'SelectFolder') {
        $expander = [System.Windows.Automation.ExpandCollapsePattern]$folder.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        $selectionInvoked = $false
        try {
            $expander.Expand()
            Start-Sleep -Milliseconds 150
            $menus = @(Descendants $root | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Menu -and $_.Current.Name -eq $folder.Current.Name -and -not $_.Current.IsOffscreen })
            if ($menus.Count -ne 1) { throw 'Folder menu not verified' }
            $choices = @(Descendants $menus[0] | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::RadioButton -and (PathEqual $_.Current.HelpText $request.cwd) -and $_.Current.IsEnabled -and -not $_.Current.IsOffscreen })
            if ($choices.Count -ne 1) { throw 'Folder choice not verified' }
            $choiceInvoke = $null
            if (-not $choices[0].TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$choiceInvoke)) { throw 'Folder choice unavailable' }
            if (-not (PromptEqual (TextValue $composers[0]) $request.prompt)) { throw 'Composer changed' }
            ([System.Windows.Automation.InvokePattern]$choiceInvoke).Invoke()
            $selectionInvoked = $true
        } finally {
            try {
                if ($expander.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { $expander.Collapse() }
                Start-Sleep -Milliseconds 250
            } catch { if (-not $selectionInvoked) { throw } }
        }
        Finish 'selected' 'exact_native_folder_explicitly_selected'
    }
    $invocationStarted = $true
    ([System.Windows.Automation.InvokePattern]$invoke).Invoke()
    Finish 'submitted' 'native_send_invoked_once'
} catch {
    if ($invocationStarted) { Finish 'uncertain' 'native_submit_outcome_unknown' }
    Finish 'blocked' 'native_accessibility_unavailable'
}
