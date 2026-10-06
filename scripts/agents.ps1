<#
  Clone, update and inspect the Albus agents hub on this machine.

  Since 2026-10-06 the hub (Documents\agents-hub by default, or
  ALBUS_AGENTS_HUB_DIR) is ONE git repo: https://github.com/JDavidcor23/agents-hub
  (private, branch main). Every agent is a plain folder agents/<id>/ committed
  straight into that repo -- no nested .git per agent any more, no GitHub
  topic to tag. A brand-new agent is committed and pushed as a DRAFT
  ("draft": true in its agent.json) from its first commit: that push IS its
  backup. It becomes a real agent for the user once its owner clears the
  draft flag (see .claude/docs/agents-hub.md).

  This script now operates on that ONE repo instead of one-repo-per-agent.
  There is no "local only" concept any more either: an agent either made it
  into a commit on the hub repo or it did not, and `status` just reports
  uncommitted/unpushed state, same as any other folder in any other repo.

  Usage (after `install`, from any PowerShell):
    clone-agents     clone the hub if this machine does not have it yet
    update-agents    fast-forward the hub from GitHub, reinstall deps that changed
    sync-agents      clone-or-update: whichever applies
    agents-status    branch/ahead/behind/dirty for the hub, dirty count per agent; changes nothing

  First time on a new machine (needs git, node and `gh auth login`):
    gh api repos/JDavidcor23/albus_agent/contents/scripts/agents.ps1 -H "Accept: application/vnd.github.raw" > $env:TEMP\agents.ps1
    powershell -ExecutionPolicy Bypass -File $env:TEMP\agents.ps1 install
  Running `install` again later refreshes this script from GitHub.

  Migrating an OLD per-agent-repo hub (no .git at its root): `clone` detects
  it, archives the whole folder to <hub>-old-<yyyyMMdd-HHmm> (never deleted
  by this script), clones the monorepo fresh, then carries back ONLY the
  local, git-ignored state for every agent id present in both copies --
  .env, .env.local, .secrets\, .wa-data\ -- plus the old results\ tree.

  ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
#>
param(
  [ValidateSet('clone', 'update', 'sync', 'status', 'install')]
  [string]$Action = 'sync',
  [string]$Owner = 'JDavidcor23'
)

# Not 'Stop': in PowerShell 5.1 a native command writing to a redirected stderr
# becomes a terminating error. Exit codes are checked by hand instead.
$ErrorActionPreference = 'Continue'

$Repo = 'agents-hub'
# The user picks the hub folder in `npm run setup`; it is stored as a user env
# var. Trimmed the same way resolveHubDir() (core/hub/hub-location.ts) trims
# it, so a whitespace-only value falls back to the default on both sides
# instead of being treated as a real path on this one.
$EnvHub = "$env:ALBUS_AGENTS_HUB_DIR".Trim()
$Hub = if ($EnvHub) { $EnvHub } else { Join-Path $env:USERPROFILE 'Documents\agents-hub' }
$AgentsDir = Join-Path $Hub 'agents'
$SelfRepo = 'albus_agent'
$SelfPath = 'scripts/agents.ps1'
# Per-agent state that never lives in the repo (root .gitignore excludes it)
# and so never travels with a plain git clone -- the only thing worth
# carrying by hand from an old hub layout.
$LocalOnlyItems = @('.env', '.env.local', '.secrets', '.wa-data')

function Write-Row([string]$tag, [string]$name, [string]$detail, [string]$color = 'Gray') {
  Write-Host ('{0,-14} {1,-18} {2}' -f "[$tag]", $name, $detail) -ForegroundColor $color
}

function Assert-Tool([string]$name, [string]$hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Host "Missing '$name'. $hint" -ForegroundColor Red
    exit 1
  }
}

# gh can hold several accounts and the ACTIVE one may be a work account. The
# owner's token goes into GH_TOKEN for this run only, and is restored at exit,
# so the shell's gh keeps answering as whoever it was. git itself picks this
# up too, as long as `gh auth setup-git` has registered gh as a credential
# helper (gh's own helper resolution checks GH_TOKEN the same way `gh auth
# token` does) -- that is why a plain `git clone`/`git pull` below still
# authenticates as $Owner.
function Enter-OwnerToken {
  $script:PreviousToken = $env:GH_TOKEN
  $token = & gh auth token -u $Owner 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $token) {
    $env:GH_TOKEN = $script:PreviousToken
    Write-Host "gh is not logged in as $Owner. Run: gh auth login" -ForegroundColor Red
    exit 1
  }
  $env:GH_TOKEN = ($token | Select-Object -First 1).Trim()
}

function Exit-OwnerToken { $env:GH_TOKEN = $script:PreviousToken }

function Test-HubIsGitRepo {
  Test-Path (Join-Path $Hub '.git')
}

function Test-HubHasContent {
  if (-not (Test-Path $Hub)) { return $false }
  return (Get-ChildItem $Hub -Force | Measure-Object).Count -gt 0
}

function Install-Deps([string]$dir) {
  if (-not (Test-Path (Join-Path $dir 'package.json'))) { return $true }
  $useCi = Test-Path (Join-Path $dir 'package-lock.json')
  Push-Location $dir
  if ($useCi) { & npm ci --no-audit --no-fund --loglevel=error | Out-Host }
  else { & npm install --no-audit --no-fund --loglevel=error | Out-Host }
  $ok = $LASTEXITCODE -eq 0
  Pop-Location
  return $ok
}

function Test-AgentDraft([string]$agentDir) {
  $manifestFile = Join-Path $agentDir 'agent.json'
  if (-not (Test-Path $manifestFile)) { return $false }
  try {
    $json = Get-Content -Raw -Path $manifestFile | ConvertFrom-Json
    return [bool]$json.draft
  } catch {
    return $false
  }
}

function Invoke-CloneFreshHub {
  $parent = Split-Path $Hub -Parent
  if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $url = "https://$Owner@github.com/$Owner/$Repo.git"
  & git clone --quiet $url $Hub
  return $LASTEXITCODE -eq 0
}

# Moves back everything a plain `git clone` never carries: the whole
# results\ tree (not git-tracked at all) plus, per agent id present in BOTH
# the old and the new hub, the local-only items in $LocalOnlyItems. Never
# deletes anything from $oldHub.
function Copy-LocalStateFromOldHub([string]$oldHub) {
  $oldResults = Join-Path $oldHub 'results'
  $newResults = Join-Path $Hub 'results'
  if (Test-Path $oldResults) {
    if (Test-Path $newResults) {
      foreach ($d in Get-ChildItem $oldResults -Directory) {
        $dest = Join-Path $newResults $d.Name
        if (-not (Test-Path $dest)) { Move-Item -Path $d.FullName -Destination $dest }
      }
    } else {
      New-Item -ItemType Directory -Force -Path (Split-Path $newResults -Parent) | Out-Null
      Move-Item -Path $oldResults -Destination $newResults
    }
    Write-Row 'carried' 'results' "from $oldHub" Green
  }

  $oldAgentsDir = Join-Path $oldHub 'agents'
  if (-not (Test-Path $oldAgentsDir)) { return }
  foreach ($d in Get-ChildItem $oldAgentsDir -Directory) {
    $id = $d.Name
    $newAgentDir = Join-Path $AgentsDir $id
    if (-not (Test-Path $newAgentDir)) { continue }
    $carried = @()
    foreach ($item in $LocalOnlyItems) {
      $src = Join-Path $d.FullName $item
      if (Test-Path $src) {
        Copy-Item -Path $src -Destination (Join-Path $newAgentDir $item) -Recurse -Force
        $carried += $item
      }
    }
    if ($carried.Count -gt 0) { Write-Row 'carried' $id ($carried -join ', ') Green }
  }
}

function Invoke-Clone {
  if (-not (Test-HubHasContent)) {
    Write-Host "Cloning agents-hub into $Hub ..." -ForegroundColor Cyan
    if (Invoke-CloneFreshHub) { Write-Row 'cloned' 'agents-hub' $Hub Green }
    else { Write-Row 'clone failed' 'agents-hub' $Hub Red; exit 1 }
    return
  }

  if (Test-HubIsGitRepo) {
    Write-Host "Hub at $Hub is already a git repo." -ForegroundColor DarkGray
    Invoke-Update
    return
  }

  # Old per-agent layout: no .git at the hub root, but folders with content.
  $stamp = Get-Date -Format 'yyyyMMdd-HHmm'
  $oldHub = "$Hub-old-$stamp"
  Write-Host "Found an old hub layout (no .git) at $Hub. Archiving it to $oldHub ..." -ForegroundColor Yellow
  Rename-Item -Path $Hub -NewName (Split-Path $oldHub -Leaf)

  if (-not (Invoke-CloneFreshHub)) {
    Write-Row 'clone failed' 'agents-hub' "$Hub (old layout preserved at $oldHub)" Red
    exit 1
  }
  Write-Row 'cloned' 'agents-hub' $Hub Green
  Copy-LocalStateFromOldHub $oldHub
  Write-Host "Old hub kept at $oldHub -- delete it by hand once you confirm everything works." -ForegroundColor Yellow
}

# Ahead/behind against the upstream of the HUB repo, after a fetch when $fetch is set.
function Get-HubState([bool]$fetch) {
  $state = [pscustomobject]@{ git = $false; branch = ''; dirty = $false; upstream = $false; ahead = 0; behind = 0 }
  if (-not (Test-HubIsGitRepo)) { return $state }
  $state.git = $true
  $state.branch = (& git -C $Hub rev-parse --abbrev-ref HEAD)
  $state.dirty = [bool](& git -C $Hub status --porcelain)
  if ($fetch) { & git -C $Hub fetch --quiet origin }
  & git -C $Hub rev-parse --abbrev-ref '@{u}' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { return $state }
  $state.upstream = $true
  $counts = (& git -C $Hub rev-list --left-right --count 'HEAD...@{u}') -split '\s+'
  $state.ahead = [int]$counts[0]
  $state.behind = [int]$counts[1]
  return $state
}

function Install-ChangedAgentDeps([string]$beforeHead) {
  if (-not (Test-Path $AgentsDir)) { return }
  $afterHead = (& git -C $Hub rev-parse HEAD)
  $changedFiles = @()
  if ($beforeHead -ne $afterHead) {
    $changedFiles = @(& git -C $Hub diff --name-only $beforeHead $afterHead)
  }
  foreach ($d in Get-ChildItem $AgentsDir -Directory) {
    $id = $d.Name
    if (-not (Test-Path (Join-Path $d.FullName 'package.json'))) { continue }
    $relPkg = "agents/$id/package.json"
    $relLock = "agents/$id/package-lock.json"
    $depsChanged = ($changedFiles -contains $relPkg) -or ($changedFiles -contains $relLock)
    $hasNodeModules = Test-Path (Join-Path $d.FullName 'node_modules')
    if (-not ($depsChanged -or -not $hasNodeModules)) { continue }
    if (Install-Deps $d.FullName) { Write-Row 'deps' $id 'npm install/ci ok' Green }
    else { Write-Row 'deps FAILED' $id 'run npm install by hand' Red }
  }
}

function Invoke-Update {
  $s = Get-HubState $true
  if (-not $s.git) {
    Write-Row 'skipped' 'agents-hub' "not a git repo at $Hub : run 'agents.ps1 clone' first" Yellow
    return
  }
  if (-not $s.upstream) { Write-Row 'skipped' 'agents-hub' 'no upstream branch' Yellow; return }
  if ($s.ahead -gt 0 -and $s.behind -gt 0) {
    Write-Row 'diverged' 'agents-hub' "$($s.ahead) local / $($s.behind) remote commit(s): merge by hand" Red
    return
  }
  if ($s.behind -eq 0) {
    if ($s.ahead -gt 0) { Write-Row 'not pushed' 'agents-hub' "$($s.ahead) commit(s): git push" Yellow }
    else { Write-Row 'up to date' 'agents-hub' '' DarkGray }
    return
  }

  $beforeHead = (& git -C $Hub rev-parse HEAD)
  # `pull --ff-only`, exactly as asked: it fails loudly (and changes nothing)
  # the moment a local uncommitted change would be clobbered, but otherwise
  # leaves unrelated dirty files alone -- so a dirty tree is not pre-blocked.
  $pullOutput = & git -C $Hub pull --ff-only --quiet 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Row 'update failed' 'agents-hub' (($pullOutput | Out-String).Trim()) Red
    return
  }
  Write-Row 'updated' 'agents-hub' "$($s.behind) new commit(s)" Green
  Install-ChangedAgentDeps $beforeHead
}

function Show-Status {
  $s = Get-HubState $true
  if (-not $s.git) {
    Write-Host "agents-hub: not a git repo at $Hub (run 'agents.ps1 clone' or 'sync-agents')" -ForegroundColor Yellow
    return
  }
  $uncommitted = @(& git -C $Hub status --porcelain)
  Write-Host ("agents-hub  branch={0}  ahead={1}  behind={2}  uncommitted={3}  ({4})" -f $s.branch, $s.ahead, $s.behind, $uncommitted.Count, $Hub) -ForegroundColor Cyan

  if (-not (Test-Path $AgentsDir)) { return }
  foreach ($d in Get-ChildItem $AgentsDir -Directory) {
    $id = $d.Name
    $agentDirty = @(& git -C $Hub status --porcelain -- "agents/$id")
    $draftTag = if (Test-AgentDraft $d.FullName) { '  [draft]' } else { '' }
    if ($agentDirty.Count -eq 0) { Write-Row 'ok' $id $draftTag.Trim() DarkGray }
    else { Write-Row 'attention' $id "$($agentDirty.Count) uncommitted file(s)$draftTag" Yellow }
  }
}

function Install-Commands {
  New-Item -ItemType Directory -Force -Path $Hub | Out-Null
  $target = Join-Path $Hub 'agents.ps1'
  # Always pull the latest copy from GitHub, so re-running install updates it.
  $raw = & gh api "repos/$Owner/$SelfRepo/contents/$SelfPath" -H 'Accept: application/vnd.github.raw'
  if ($LASTEXITCODE -ne 0 -or -not $raw) { Write-Host "Could not download $SelfPath from $Owner/$SelfRepo." -ForegroundColor Red; exit 1 }
  Set-Content -Path $target -Value ($raw -join "`r`n") -Encoding ASCII
  Write-Host "Script saved to $target" -ForegroundColor Green

  # Profile functions only load if the user may run local scripts.
  $policy = Get-ExecutionPolicy
  if ($policy -eq 'Restricted' -or $policy -eq 'Undefined' -or $policy -eq 'AllSigned') {
    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
    Write-Host 'Execution policy for your user set to RemoteSigned (needed to load the commands).' -ForegroundColor Yellow
  }

  $marker = '# albus-agents commands'
  if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Force -Path $PROFILE | Out-Null }
  if (-not (Select-String -Path $PROFILE -SimpleMatch $marker -Quiet)) {
    $block = @"

$marker
function clone-agents  { & '$target' clone }
function update-agents { & '$target' update }
function sync-agents   { & '$target' sync }
function agents-status { & '$target' status }
"@
    Add-Content -Path $PROFILE -Value $block -Encoding ASCII
    Write-Host "Commands added to $PROFILE. Open a new PowerShell to use them." -ForegroundColor Green
  } else {
    Write-Host 'Commands already in your profile.' -ForegroundColor DarkGray
  }
}

Assert-Tool 'git' 'Install it: winget install Git.Git'
Assert-Tool 'gh' 'Install it: winget install GitHub.cli'
Enter-OwnerToken
try {
  if ($Action -eq 'install') {
    Install-Commands
    $Action = 'sync'
  }
  if ($Action -ne 'status') { Assert-Tool 'npm' 'Install Node.js: winget install OpenJS.NodeJS.LTS' }

  switch ($Action) {
    'status' { Show-Status }
    'clone'  { Invoke-Clone }
    'update' { Invoke-Update }
    # sync = clone-or-update: Invoke-Clone itself falls back to Invoke-Update
    # when the hub already exists as a git repo.
    'sync'   { Invoke-Clone }
    default  { }
  }
} finally {
  Exit-OwnerToken
}
