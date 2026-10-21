# Bundles everything git does NOT carry (secrets, local state, Claude config) into ONE
# password-protected 7z archive, to move this PC to a new machine by USB.
#
#   powershell -File scripts\migrate-export.ps1 -DryRun    # list file NAMES only, writes nothing
#   powershell -File scripts\migrate-export.ps1            # build the archive (asks for a password)
#
# It never prints file contents. The password is typed into 7z's own prompt, so it
# never lands in shell history or on a command line.
param(
  [string]$Out = (Join-Path $HOME 'Desktop\albus-migration.7z'),
  [switch]$DryRun,
  [switch]$IncludeResults,  # also bundle agents-hub\results (can be large)
  [switch]$IncludeWhatsApp  # also bundle the WhatsApp session (thousands of files; see MANUAL)
)

$ErrorActionPreference = 'Stop'
$docs = Join-Path $HOME 'Documents'

$repos = @(
  "$docs\agents-hub",
  "$docs\web\albus_agent",
  "$docs\web\good-practice",
  "$docs\web\job\dashboard-next",
  "$docs\web\job\nemo-next",
  "$docs\web\job\next",
  "$docs\web\job\form30x"
)

# Regenerable or huge: never worth carrying.
$skip = '(^|/)(node_modules|\.next|dist|out|__pycache__|\.venv|venv|\.turbo|coverage|\.husky|\.worktrees|\.git|\.temp|\.vercel|\.superpowers|graphify-out|vps-snapshot)/'
if (-not $IncludeResults) { $skip = $skip.Replace('node_modules|', 'node_modules|results|') }
# WhatsApp sessions live on ONE machine only (see MANUAL): linking a second one kicks the first.
if (-not $IncludeWhatsApp) { $skip = $skip.Replace('node_modules|', 'node_modules|\.wa-data|') }
$skipExt = '(\.(log|tmp|pyc|lock|tsbuildinfo)$)|((^|/)next-env\.d\.ts$)'

$files = [System.Collections.Generic.List[string]]::new()

# 1. Anything git ignores inside each repo: .env files, .secrets, tokens, local skills, rules...
foreach ($repo in $repos) {
  if (-not (Test-Path "$repo\.git")) { Write-Warning "skipped (not a repo here): $repo"; continue }
  # git warns on dangling worktree dirs; under 'Stop' PowerShell would turn that into a failure.
  $ErrorActionPreference = 'Continue'
  $ignored = git -C $repo -c core.quotepath=off ls-files --others --ignored --exclude-standard 2>$null
  $ErrorActionPreference = 'Stop'
  foreach ($rel in $ignored) {
    if ($rel -match $skip -or $rel -match $skipExt) { continue }
    $files.Add((Join-Path $repo ($rel -replace '/', '\')))
  }
}

# 2. Claude config + the user's own memory (transcripts are skipped on purpose).
$claude = Join-Path $HOME '.claude'
foreach ($name in 'CLAUDE.md', 'settings.json', 'settings.local.json', 'skills', 'agents', 'hooks', 'rules', 'commands', 'mcp') {
  $p = Join-Path $claude $name
  if (Test-Path $p) { $files.Add($p) }
}
Get-ChildItem (Join-Path $claude 'projects') -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $mem = Join-Path $_.FullName 'memory'
  if (Test-Path $mem) { $files.Add($mem) }
}

# 3. Loose files outside any repo.
foreach ($p in (Join-Path $HOME '.claude.json'), (Join-Path $HOME '.gitconfig'), "$docs\web\job\CLAUDE.md") {
  if (Test-Path $p) { $files.Add($p) }
}

# Archive paths must be relative to $HOME so the import works under any user name.
$prefix = $HOME.TrimEnd('\') + '\'
$rels = $files | Where-Object { $_.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { $_.Substring($prefix.Length) } | Sort-Object -Unique

Write-Host "$($rels.Count) entries (files or folders):"
$rels | ForEach-Object { Write-Host "  $_" }

if ($DryRun) { Write-Host "`nDry run: nothing written."; return }

if (-not (Get-Command 7z -ErrorAction SilentlyContinue)) {
  throw "7z not found. Install it first:  scoop install 7zip"
}

$list = Join-Path $env:TEMP 'albus-migration-list.txt'
Set-Content -Path $list -Value $rels -Encoding UTF8
try {
  Push-Location $HOME
  if (Test-Path $Out) { throw "Refusing to overwrite existing archive: $Out" }
  # '-p' with no value = 7z asks for the password itself; '-mhe=on' also encrypts file names.
  & 7z a -t7z -mx=3 -mhe=on '-p' $Out "@$list"
  if ($LASTEXITCODE -ne 0) { throw "7z failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
  Remove-Item $list -ErrorAction SilentlyContinue
}
Write-Host "`nArchive: $Out"
Write-Host "Copy it to a USB. Not WhatsApp, not email, not Drive."
