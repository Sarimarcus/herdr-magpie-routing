# Installs the magpie-routing mod into the local Herdr desktop app and adds a
# "Magpie" button next to Files and Changes.
# Usage:  powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Vps olivier@your-vps [-Machine vps]
# -Machine: the name Herdr gives the VPS (Settings > Machines), where magpie runs.
param(
  [Parameter(Mandatory = $true)][string]$Vps,
  [string]$Machine = "vps",
  [string]$AppHome
)
$ErrorActionPreference = "Stop"

function Fail($msg) { Write-Host "STOPPED: $msg" -ForegroundColor Red; exit 1 }

# Runs herdr-app with a time limit: returns its exit code, or 124 when it did not finish in time.
function Invoke-HerdrApp([string[]]$HerdrArgs, [int]$Seconds = 30) {
  $p = Start-Process -FilePath $herdrApp.Source -ArgumentList $HerdrArgs -NoNewWindow -PassThru
  $null = $p.Handle
  if (-not $p.WaitForExit($Seconds * 1000)) {
    try { $p.Kill() } catch {}
    Write-Host "herdr-app $($HerdrArgs -join ' ') did not finish within $Seconds s; skipped." -ForegroundColor Yellow
    return 124
  }
  return $p.ExitCode
}

# 1. Find the app's config folder
if (-not $AppHome) {
  $candidates = @($env:HERDR_APP_HOME, "$HOME\.config\herdr-app", "$env:APPDATA\herdr-app", "$env:LOCALAPPDATA\herdr-app") | Where-Object { $_ }
  $AppHome = $candidates | Where-Object { Test-Path (Join-Path $_ "layouts") } | Select-Object -First 1
}
if (-not $AppHome -or -not (Test-Path (Join-Path $AppHome "layouts"))) {
  Fail "herdr-app config folder not found. Re-run with -AppHome <folder that contains layouts\ and mods\>."
}
Write-Host "herdr-app config: $AppHome"
$mods = Join-Path $AppHome "mods"
$layouts = Join-Path $AppHome "layouts"

# 2. Copy the mod from the VPS
Write-Host "Copying the mod from $Vps ..."
# Download to a temp folder first: herdr-app holds the loaded main.js open, so scp
# cannot write over it ("Broken pipe"), but Copy-Item can.
$stage = Join-Path $env:TEMP "magpie-routing-$PID"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage | Out-Null
scp -r "${Vps}:dev/tools/herdr-magpie-routing/mod/magpie-routing" "$stage"
if ($LASTEXITCODE -ne 0) { Fail "scp failed." }
New-Item -ItemType Directory -Path (Join-Path $mods "magpie-routing") -Force | Out-Null
try {
  Copy-Item (Join-Path $stage "magpie-routing\*") (Join-Path $mods "magpie-routing") -Recurse -Force -ErrorAction Stop
} catch {
  Fail "Could not overwrite the installed mod ($($_.Exception.Message)). Quit herdr-app and run this script again."
}
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
$modMain = Join-Path $mods "magpie-routing\main.js"
$modText = Get-Content $modMain -Raw -Encoding UTF8
$pinned = [regex]::Replace($modText, '(?m)^const MACHINE = .*;$', ('const MACHINE = "' + $Machine + '";'))
if ($pinned -notmatch ('const MACHINE = "' + [regex]::Escape($Machine) + '";')) { Fail "could not set MACHINE in magpie-routing/main.js." }
[System.IO.File]::WriteAllText($modMain, $pinned, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Magpie panel reads from Herdr machine '$Machine'"

# 3. Clone the main layout and the tab bar (shipped ones are read-only)
$herdrApp = Get-Command herdr-app -ErrorAction SilentlyContinue
$layoutFile = Join-Path $layouts "my-main.json"
$tabsFile = Join-Path $mods "my-tabs\main.js"
if (-not (Test-Path $layoutFile) -or -not (Test-Path $tabsFile)) {
  if (-not $herdrApp) {
    Fail "herdr-app is not on PATH. In the app, open the command palette (Ctrl+Shift+P): 'Duplicate layout' main -> my-main, and 'Duplicate mod' tabs -> my-tabs. Then run this script again."
  }
  if (-not (Test-Path $tabsFile)) {
    if ((Invoke-HerdrApp @("do", "mod.clone", "--name", "tabs", "--as", "my-tabs")) -ne 0) { Fail "herdr-app do mod.clone failed." }
  }
  if (-not (Test-Path $layoutFile)) {
    if ((Invoke-HerdrApp @("do", "layout.clone", "--name", "main", "--as", "my-main")) -ne 0) { Fail "herdr-app do layout.clone failed." }
  }
  Start-Sleep -Seconds 1
  if (-not (Test-Path $layoutFile) -or -not (Test-Path $tabsFile)) { Fail "the clones were not created." }
}

# 4. Layout: use my-tabs, add the magpie block to the right panel
$layoutText = Get-Content $layoutFile -Raw -Encoding UTF8
Copy-Item $layoutFile "$layoutFile.bak" -Force
$layout = $layoutText | ConvertFrom-Json
$state = @{ tabs = $false; body = $false }
function Walk($node) {
  if ($null -eq $node) { return }
  if ($node -is [System.Array]) { foreach ($n in $node) { Walk $n }; return }
  if ($node -isnot [System.Management.Automation.PSCustomObject]) { return }
  if ($node.content -and $node.content.mod -eq "tabs") { $node.content.mod = "my-tabs"; $state.tabs = $true }
  if ($node.content -and $node.content.mod -eq "my-tabs") { $state.tabs = $true }
  if ($node.id -eq "panel-body") {
    $state.body = $true
    if (-not ($node.children | Where-Object { $_.id -eq "magpie" })) {
      $block = [PSCustomObject]@{ id = "magpie"; type = "block"; content = [PSCustomObject]@{ mod = "magpie-routing" } }
      $node.children = @($node.children) + $block
    }
  }
  foreach ($p in $node.PSObject.Properties) { Walk $p.Value }
}
Walk $layout
if (-not $state.tabs) { Fail "no tab bar block (mod 'tabs') found in my-main.json." }
if (-not $state.body) { Fail "no 'panel-body' stack found in my-main.json." }
$json = $layout | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText($layoutFile, $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Updated $layoutFile (backup: my-main.json.bak)"

# 5. Tab bar: a Magpie button after Changes
$tabs = Get-Content $tabsFile -Raw -Encoding UTF8
if ($tabs -notmatch 'panelButton\("magpie"') {
  Copy-Item $tabsFile "$tabsFile.bak" -Force
  $enabledOld = 'const enabled = shared("workspace.panels") ?? ["files", "changes"];'
  $enabledNew = 'const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "magpie"];'
  if (-not $tabs.Contains($enabledOld)) { Fail "my-tabs/main.js: the 'const enabled = ...' line differs from the expected one; edit it by hand." }
  $tabs = $tabs.Replace($enabledOld, $enabledNew)
  $anchor = [regex]::Match($tabs, '\.when\(enabled\.includes\("changes"\)[^\r\n]*?changes\.svg"\)\)\)')
  if (-not $anchor.Success) { Fail "my-tabs/main.js: the Changes button line was not found; add the Magpie button by hand." }
  $button = '.child(panelButton("magpie", "Magpie", "mods/magpie-routing/icon.svg"))'
  $tabs = $tabs.Insert($anchor.Index + $anchor.Length, "`n      $button")
  [System.IO.File]::WriteAllText($tabsFile, $tabs, (New-Object System.Text.UTF8Encoding $false))
  Write-Host "Updated $tabsFile (backup: main.js.bak)"
}

# 6. Check
if ($herdrApp) {
  foreach ($m in @("my-tabs", "magpie-routing")) {
    $code = Invoke-HerdrApp @("check", "`"$(Join-Path $mods $m)`"")
    if ($code -ne 0 -and $code -ne 124) { Fail "herdr-app check failed for mods\$m (error above)." }
  }
  $code = Invoke-HerdrApp @("do", "layout.switch", "--name", "my-main")
  if ($code -eq 124) { Write-Host "Switch to the my-main layout from the command palette." -ForegroundColor Yellow }
  elseif ($code -ne 0) { Fail "herdr-app do layout.switch failed." }
} else {
  Write-Host "herdr-app is not on PATH: mod checks skipped. Switch to the my-main layout from the command palette." -ForegroundColor Yellow
}
$err = Join-Path $layouts "my-main.error"
if (Test-Path $err) { Fail "layout error: $(Get-Content $err -Raw)" }
Write-Host "Done. Click 'Magpie' next to Files and Changes." -ForegroundColor Green
Write-Host "If the window breaks: Ctrl+Alt+Shift+Escape returns to the default layout."
exit 0
