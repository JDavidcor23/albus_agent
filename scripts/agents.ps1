<#
  Clone and update every Albus hub agent on this machine, from GitHub.

  An agent repo is any repo owned by $Owner that carries the GitHub topic
  "albus-agent". There is no list to maintain: tag a new agent's repo and the
  next run picks it up. Each one lands in Documents\agents-hub\agents\<id>,
  where <id> comes from the repo's agent.json (the folder MUST equal the id,
  see .claude/docs/agents-hub.md), falling back to the repo name.

  It never touches work in progress: a repo with uncommitted changes or with
  commits that diverged from GitHub is reported and skipped, never reset.

  Usage (after `install`, from any PowerShell):
    clone-agents     clone the agents this machine does not have yet
    update-agents    fast-forward every agent already here
    sync-agents      both
    agents-status    what is ahead, behind, dirty or local-only; changes nothing

  First time on a new machine (needs git, node and `gh auth login`):
    gh api repos/JDavidcor23/albus_agent/contents/scripts/agents.ps1 -H "Accept: application/vnd.github.raw" > $env:TEMP\agents.ps1
    powershell -ExecutionPolicy Bypass -File $env:TEMP\agents.ps1 install
  Running `install` again later refreshes this script from GitHub.

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

$Topic = 'albus-agent'
# Same root Albus computes by hand (never the shell's Documents folder, which
# OneDrive can redirect): see documentsDir() in src/main/paths.ts.
$Hub = Join-Path $env:USERPROFILE 'Documents\agents-hub'
$AgentsDir = Join-Path $Hub 'agents'
$IdPattern = '^[a-z0-9][a-z0-9-]{1,48}$'
$SelfRepo = 'albus_agent'
$SelfPath = 'scripts/agents.ps1'

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
# so the shell's gh keeps answering as whoever it was.
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

# Returns @{ repo; id; branch } for every tagged repo. Asks the authenticated
# API, not search: search does not see a topic for minutes after it is added,
# and the public users/<owner>/repos endpoint never lists private repos.
function Get-AgentRepos {
  # The jq filter must not contain a single string literal: PowerShell 5.1
  # strips embedded double quotes when it passes arguments to a native exe
  # (join(",") reaches gh as join(,)). @csv/@tsv need none.
  # GitHub answers a transient 502 now and then (seen while writing this).
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $lines = & gh api 'user/repos?affiliation=owner&per_page=100' --paginate -q '.[] | [.name, .default_branch, (.topics | @csv)] | @tsv'
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds (2 * $attempt)
  }
  if ($LASTEXITCODE -ne 0) { Write-Host 'Could not list repos from GitHub.' -ForegroundColor Red; exit 1 }
  foreach ($line in $lines) {
    $cols = $line -split "`t"
    if ($cols.Count -lt 3 -or ((($cols[2] -replace '"', '') -split ',') -notcontains $Topic)) { continue }
    [pscustomobject]@{ repo = $cols[0]; branch = $cols[1]; id = (Get-AgentId $cols[0]) }
  }
}

function Get-AgentId([string]$repo) {
  $raw = & gh api "repos/$Owner/$repo/contents/agent.json" -H 'Accept: application/vnd.github.raw' 2>$null
  if ($LASTEXITCODE -eq 0 -and $raw) {
    try {
      $id = (($raw -join "`n") | ConvertFrom-Json).id
      if ($id -match $IdPattern) { return $id }
    } catch { }
  }
  # No agent.json yet (an agent still being designed): the repo name is the id.
  return $repo
}

function Install-Deps([string]$dir) {
  if (-not (Test-Path (Join-Path $dir 'package.json'))) { return $true }
  Push-Location $dir
  & npm install --no-audit --no-fund --loglevel=error | Out-Host
  $ok = $LASTEXITCODE -eq 0
  Pop-Location
  return $ok
}

function Invoke-Clone($agent) {
  $dir = Join-Path $AgentsDir $agent.id
  if (Test-Path $dir) { return $false }
  & gh repo clone "$Owner/$($agent.repo)" $dir -- --quiet
  if ($LASTEXITCODE -ne 0) { Write-Row 'clone failed' $agent.id "$Owner/$($agent.repo)" Red; return $true }
  $deps = Install-Deps $dir
  if ($deps) { Write-Row 'cloned' $agent.id "from $Owner/$($agent.repo)" Green }
  else { Write-Row 'cloned' $agent.id 'but npm install FAILED: run it by hand' Yellow }
  return $true
}

# Ahead/behind against the upstream, after a fetch when $fetch is set.
function Get-RepoState([string]$dir, [bool]$fetch) {
  $state = [pscustomobject]@{ git = $false; dirty = $false; upstream = $false; ahead = 0; behind = 0 }
  if (-not (Test-Path (Join-Path $dir '.git'))) { return $state }
  $state.git = $true
  $state.dirty = [bool](& git -C $dir status --porcelain)
  & git -C $dir rev-parse --abbrev-ref '@{u}' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { return $state }
  $state.upstream = $true
  if ($fetch) { & git -C $dir fetch --quiet }
  $counts = (& git -C $dir rev-list --left-right --count 'HEAD...@{u}') -split '\s+'
  $state.ahead = [int]$counts[0]
  $state.behind = [int]$counts[1]
  return $state
}

function Invoke-Update([string]$name, [string]$dir) {
  $s = Get-RepoState $dir $true
  if (-not $s.git) { Write-Row 'skipped' $name 'not a git repo' Yellow; return }
  if (-not $s.upstream) { Write-Row 'skipped' $name 'no upstream branch: is it on GitHub?' Yellow; return }
  if ($s.dirty) {
    Write-Row 'skipped' $name 'uncommitted changes: commit or stash, then run again' Yellow
    return
  }
  if ($s.ahead -gt 0 -and $s.behind -gt 0) {
    Write-Row 'diverged' $name "$($s.ahead) local / $($s.behind) remote commits: merge by hand" Red
    return
  }
  if ($s.behind -eq 0) {
    if ($s.ahead -gt 0) { Write-Row 'not pushed' $name "$($s.ahead) commit(s): git push" Yellow }
    else { Write-Row 'up to date' $name '' DarkGray }
    return
  }
  $before = (& git -C $dir rev-parse HEAD)
  & git -C $dir merge --ff-only --quiet '@{u}'
  if ($LASTEXITCODE -ne 0) { Write-Row 'update failed' $name 'git merge --ff-only failed' Red; return }
  $depsChanged = & git -C $dir diff --name-only $before HEAD -- package.json package-lock.json
  $note = "$($s.behind) new commit(s)"
  if ($depsChanged) {
    if (Install-Deps $dir) { $note += ', dependencies reinstalled' }
    else { $note += ', npm install FAILED: run it by hand' }
  }
  Write-Row 'updated' $name $note Green
}

function Show-Status($agents) {
  $known = @{}
  foreach ($a in $agents) {
    $known[$a.id] = $true
    $dir = Join-Path $AgentsDir $a.id
    if (-not (Test-Path $dir)) { Write-Row 'missing' $a.id 'on GitHub, not here: clone-agents' Cyan; continue }
    $s = Get-RepoState $dir $true
    $parts = @()
    if ($s.dirty) { $parts += 'uncommitted changes' }
    if ($s.ahead -gt 0) { $parts += "$($s.ahead) to push" }
    if ($s.behind -gt 0) { $parts += "$($s.behind) to pull" }
    if (-not $s.upstream) { $parts += 'no upstream' }
    if ($parts.Count -eq 0) { Write-Row 'ok' $a.id '' DarkGray } else { Write-Row 'attention' $a.id ($parts -join ', ') Yellow }
  }
  Show-LocalOnly $known
}

# Agents that exist here but not on GitHub: the laptop will never see them.
function Show-LocalOnly($known) {
  if (-not (Test-Path $AgentsDir)) { return }
  foreach ($d in Get-ChildItem $AgentsDir -Directory) {
    if (-not $known.ContainsKey($d.Name)) {
      Write-Row 'local only' $d.Name "not on GitHub with topic '$Topic': gh repo create, then gh repo edit --add-topic $Topic" Magenta
    }
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
  New-Item -ItemType Directory -Force -Path $AgentsDir | Out-Null

  $agents = @(Get-AgentRepos)
  Write-Host "$($agents.Count) agent(s) on GitHub with topic '$Topic'. Hub: $AgentsDir`n" -ForegroundColor Cyan

  switch ($Action) {
    'status' { Show-Status $agents }
    default {
      foreach ($a in $agents) {
        $dir = Join-Path $AgentsDir $a.id
        $exists = Test-Path $dir
        if (-not $exists -and $Action -ne 'update') { [void](Invoke-Clone $a) }
        elseif ($exists -and $Action -ne 'clone') { Invoke-Update $a.id $dir }
        elseif (-not $exists) { Write-Row 'missing' $a.id 'not here: clone-agents' Cyan }
        else { Write-Row 'already here' $a.id 'update-agents to pull' DarkGray }
      }
      $known = @{}
      foreach ($a in $agents) { $known[$a.id] = $true }
      Show-LocalOnly $known
    }
  }
} finally {
  Exit-OwnerToken
}
