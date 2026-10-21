# Daily Computrabajo run for Jorge's mother (skill /postula-mama).
# Runs Claude headless and grants the orca browser permission for this run only,
# so auto mode does not block applying on her behalf.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

claude -p "/postula-mama" --model sonnet --allowedTools "Bash(orca *)" "Bash(sleep *)""Bash(node C:/Users/PC/Documents/agents-hub/agents/claude-relay/scripts/send-file.ts *)" "Read" "Write" "Edit" "Glob" "Grep" "Skill"
