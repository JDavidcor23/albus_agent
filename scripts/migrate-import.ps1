# Restores the archive built by migrate-export.ps1 into this user's home folder.
#
#   powershell -File scripts\migrate-import.ps1 -Archive E:\albus-migration.7z
#
# By default existing files are KEPT (nothing is overwritten); pass -Overwrite to replace them.
# Claude keys each project's memory folder by its path (C--Users-<user>-Documents-...),
# so when this machine's user name differs the memory folders are copied under the new key.
param(
  [Parameter(Mandatory)][string]$Archive,
  [switch]$Overwrite
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Archive)) { throw "Archive not found: $Archive" }
if (-not (Get-Command 7z -ErrorAction SilentlyContinue)) {
  throw "7z not found. Install it first:  scoop install 7zip"
}

# -aos = skip existing files, -aoa = overwrite. 7z prompts for the password itself.
$mode = if ($Overwrite) { '-aoa' } else { '-aos' }
& 7z x $Archive "-o$HOME" $mode
if ($LASTEXITCODE -ne 0) { throw "7z failed with exit code $LASTEXITCODE" }

# Rename Claude's per-project memory keys when the user name changed.
$projects = Join-Path $HOME '.claude\projects'
$newUser = $env:USERNAME
Get-ChildItem $projects -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.Name -match '^([A-Za-z])--Users-(.+?)-(Documents-.+)$') {
    $oldUser = $Matches[2]
    if ($oldUser -ne $newUser) {
      $newName = "$($Matches[1])--Users-$newUser-$($Matches[3])"
      $dest = Join-Path $projects $newName
      if (-not (Test-Path $dest)) {
        Copy-Item $_.FullName $dest -Recurse
        Write-Host "Memory key renamed: $($_.Name) -> $newName"
      }
    }
  }
}

Write-Host @"

Restored. Still to do by hand:
  - gh auth login (personal account) and the 30X account; ~/.gitconfig was restored
  - gentle-ai sync   (it owns the managed blocks of ~/.claude/CLAUDE.md)
  - browser sessions (Orca: Gmail, LinkedIn, Computrabajo, UTEL) are NOT carried: log in again
  - WhatsApp lives on ONE machine only: do not link it here while the old PC has it
  - npm run hub -- list   to confirm the agents see their .env files
"@
