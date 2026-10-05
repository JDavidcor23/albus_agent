import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { useState, type ReactNode } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'

import { Confirm } from '../components/confirm'
import { hubDirFromParent, validateHubParent } from '../../main/core/hub/hub-location'
import {
  copyHub,
  findHardcodedHubPaths,
  findScheduledTasksUsing,
  setHubDirPersistently,
  verifyHubCopy,
  type ScheduledTaskHit
} from '../../main/hub/setup-io'
import { errorMessage } from '../setup-data'

interface Props {
  currentHub: string
  /** Called when the user leaves; `changed` = the hub setting moved this session. */
  onDone: (changed: boolean) => void
}

type Phase =
  | { name: 'input' }
  | { name: 'confirm'; newHub: string; count: number }
  | { name: 'use-existing'; newHub: string }
  | { name: 'working'; message: string }
  | {
      name: 'done'
      changed: boolean
      lines: string[]
      warnings: string[]
      scheduledTasks: ScheduledTaskHit[]
      /** The old hub path, when this run moved FROM one — drives the Task Scheduler warning line. */
      oldHub: string | null
    }
  | { name: 'failed'; lines: string[] }

const MAX_WARNINGS = 15

function defaultParent(): string {
  return win32.join(process.env.USERPROFILE ?? '', 'Documents')
}

/** Case-insensitive, separator-normalized — Windows paths. */
function samePath(a: string, b: string): boolean {
  return win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase()
}

/** `inner` is strictly inside `outer` — copying a hub into itself (or the reverse) would recurse. */
function isInside(inner: string, outer: string): boolean {
  const o = win32.resolve(outer).toLowerCase().replace(/\\+$/, '')
  return win32.resolve(inner).toLowerCase().startsWith(`${o}\\`)
}

/**
 * Something is already at `dir`: a folder with anything in it, or a file.
 * Copying INTO it would merge — robocopy /E overwrites same-named files, so
 * another hub's agents' `.env` files would be replaced. An empty folder is fine.
 */
function isOccupied(dir: string): boolean {
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).length > 0
  } catch {
    return true
  }
}

function countAgents(hubDir: string): number {
  const agentsDir = join(hubDir, 'agents')
  try {
    return readdirSync(agentsDir).filter((name) => {
      if (name.startsWith('.')) return false
      try {
        return statSync(join(agentsDir, name)).isDirectory()
      } catch {
        return false
      }
    }).length
  } catch {
    return 0
  }
}

function hardcodedWarnings(hubDir: string): string[] {
  const hits = findHardcodedHubPaths(hubDir)
  const lines = hits.slice(0, MAX_WARNINGS).map((hit) => `${hit.file}:${hit.line}`)
  if (hits.length > MAX_WARNINGS) lines.push(`… and ${hits.length - MAX_WARNINGS} more`)
  return lines
}

/**
 * Where the hub lives. The old hub is NEVER moved or deleted: the flow is
 * copy → verify → only then persist the new setting. Any copy or verify
 * problem aborts with the old setting untouched. A destination that already
 * holds something is never copied into: the user can adopt it as is, or not.
 */
export function HubLocation({ currentHub, onDone }: Props): ReactNode {
  // A relative ALBUS_AGENTS_HUB_DIR is not a hub (it resolves against
  // whatever cwd this runs in): there is no current hub to copy from.
  const currentIsReal = win32.isAbsolute(currentHub)
  const hasCurrent = currentIsReal && existsSync(currentHub)

  const [parent, setParent] = useState(defaultParent)
  const [error, setError] = useState('')
  const [phase, setPhase] = useState<Phase>({ name: 'input' })

  useInput(
    (_input, key) => {
      if (phase.name === 'input' && key.escape) onDone(false)
      else if (phase.name === 'done' && (key.return || key.escape)) onDone(phase.changed)
      else if (phase.name === 'failed' && (key.return || key.escape)) setPhase({ name: 'input' })
    },
    { isActive: phase.name === 'input' || phase.name === 'done' || phase.name === 'failed' }
  )

  const finish = async (newHub: string, copyFrom: string | null): Promise<void> => {
    try {
      if (copyFrom !== null) {
        setPhase({ name: 'working', message: `Copying ${copyFrom} to ${newHub}…` })
        const copy = await copyHub(copyFrom, newHub)
        if (!copy.ok) {
          setPhase({
            name: 'failed',
            lines: ['The copy failed. The hub setting was NOT changed.', ...copy.output.split(/\r?\n/).slice(-10)]
          })
          return
        }

        setPhase({ name: 'working', message: 'Verifying the copy…' })
        const problems = await verifyHubCopy(copyFrom, newHub)
        if (problems.length > 0) {
          setPhase({
            name: 'failed',
            lines: [
              'The copy did not verify. The hub setting was NOT changed; the new folder may hold a partial copy.',
              ...problems
            ]
          })
          return
        }
      } else {
        mkdirSync(newHub, { recursive: true })
      }

      setPhase({ name: 'working', message: 'Saving ALBUS_AGENTS_HUB_DIR…' })
      await setHubDirPersistently(newHub)
    } catch (err: unknown) {
      setPhase({ name: 'failed', lines: ['The hub setting was NOT changed.', errorMessage(err)] })
      return
    }

    // Past this point the setting HAS changed — nothing below may report otherwise.
    const lines = [`The hub is now ${newHub}.`]
    if (copyFrom !== null) {
      lines.push(`The old folder ${copyFrom} was left untouched.`)
      lines.push(
        'Scheduled tasks and Orca automations that point at the old folder keep running the OLD copy: re-register them before deleting it.'
      )
    }
    lines.push('Open a new terminal for the change to apply everywhere.')
    let warnings: string[]
    try {
      warnings = hardcodedWarnings(newHub)
    } catch (err: unknown) {
      warnings = [`Could not scan the new hub for hardcoded paths: ${errorMessage(err)}`]
    }
    let scheduledTasks: ScheduledTaskHit[] = []
    if (copyFrom !== null) {
      try {
        scheduledTasks = await findScheduledTasksUsing(copyFrom)
      } catch {
        // Read-only lookup, advisory only — a failure here must never block
        // reporting that the hub move itself already succeeded.
        scheduledTasks = []
      }
    }
    setPhase({ name: 'done', changed: true, lines, warnings, scheduledTasks, oldHub: copyFrom })
  }

  const onSubmit = (value: string): void => {
    const reason = validateHubParent(value)
    if (reason !== null) {
      setError(reason)
      return
    }
    setError('')

    const newHub = hubDirFromParent(value.trim())
    if (currentIsReal && samePath(newHub, currentHub)) {
      if (existsSync(currentHub)) {
        setPhase({
          name: 'done',
          changed: false,
          lines: [`The hub stays at ${currentHub}.`],
          warnings: [],
          scheduledTasks: [],
          oldHub: null
        })
      } else {
        // First run, the user kept the location the hub already resolves to
        // (the default, or the variable's value): it only has to exist —
        // there is no new setting to persist, so no setx.
        try {
          mkdirSync(currentHub, { recursive: true })
          setPhase({
            name: 'done',
            changed: true,
            lines: [`Created the hub at ${currentHub}.`],
            warnings: [],
            scheduledTasks: [],
            oldHub: null
          })
        } catch (err: unknown) {
          setPhase({ name: 'failed', lines: [`Could not create ${currentHub}.`, errorMessage(err)] })
        }
      }
      return
    }

    if (hasCurrent && (isInside(newHub, currentHub) || isInside(currentHub, newHub))) {
      setError('The new hub cannot be inside the current one, or the other way around.')
      return
    }

    if (isOccupied(newHub)) {
      setPhase({ name: 'use-existing', newHub })
    } else if (hasCurrent) {
      setPhase({ name: 'confirm', newHub, count: countAgents(currentHub) })
    } else {
      void finish(newHub, null)
    }
  }

  if (phase.name === 'confirm') {
    return (
      <Box flexDirection="column">
        <Text bold>Hub location</Text>
        <Confirm
          question={`Copy ${phase.count} agents from ${currentHub} to ${phase.newHub}? The old folder stays untouched.`}
          defaultYes={false}
          onAnswer={(yes) => {
            if (yes) void finish(phase.newHub, currentHub)
            else setPhase({ name: 'input' })
          }}
        />
      </Box>
    )
  }

  if (phase.name === 'use-existing') {
    return (
      <Box flexDirection="column">
        <Text bold>Hub location</Text>
        <Text color="yellow">{phase.newHub} already exists and is not empty, so nothing will be copied into it.</Text>
        <Confirm
          question={`Use the existing hub at ${phase.newHub} as is (no copy)?`}
          defaultYes={false}
          onAnswer={(yes) => {
            if (yes) void finish(phase.newHub, null)
            else setPhase({ name: 'input' })
          }}
        />
      </Box>
    )
  }

  if (phase.name === 'working') {
    return (
      <Box flexDirection="column">
        <Text bold>Hub location</Text>
        <Text color="cyan">{phase.message}</Text>
      </Box>
    )
  }

  if (phase.name === 'done' || phase.name === 'failed') {
    const ok = phase.name === 'done'
    return (
      <Box flexDirection="column">
        <Text bold>Hub location</Text>
        {phase.lines.map((line, index) => (
          <Text key={index} color={ok ? undefined : 'red'}>
            {line}
          </Text>
        ))}
        {phase.name === 'done' && phase.warnings.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="yellow">These agent files hardcode Documents\agents-hub and will not follow the move:</Text>
            {phase.warnings.map((line) => (
              <Text key={line} color="yellow">
                {'  '}
                {line}
              </Text>
            ))}
          </Box>
        )}
        {phase.name === 'done' && phase.scheduledTasks.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="yellow">These Task Scheduler tasks still point at the OLD hub folder:</Text>
            {phase.scheduledTasks.map((task) => (
              <Text key={`${task.taskName}:${task.action}`} color="yellow">
                {'  '}
                {task.taskName} → {task.action}
              </Text>
            ))}
          </Box>
        )}
        <Text dimColor>[enter] {ok ? 'back' : 'try again'}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold>Hub location</Text>
      <Text>
        Current hub: {currentHub}
        {!currentIsReal && <Text color="yellow"> (not an absolute path: ignored, nothing will be copied from it)</Text>}
      </Text>
      <Box marginTop={1}>
        <Text>Parent folder: </Text>
        <TextInput value={parent} onChange={setParent} onSubmit={onSubmit} />
      </Box>
      <Text>
        Hub will be: <Text color="cyan">{parent.trim() === '' ? '…' : hubDirFromParent(parent.trim())}</Text>
      </Text>
      {error !== '' && <Text color="red">{error}</Text>}
      <Text dimColor>[enter] use this folder{'  '}[esc] back</Text>
    </Box>
  )
}
