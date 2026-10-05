import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { useState, type ReactNode } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'

import { Confirm } from '../components/confirm'
import { hubDirFromParent, validateHubParent } from '../../main/core/hub/hub-location'
import { copyHub, findHardcodedHubPaths, setHubDirPersistently, verifyHubCopy } from '../../main/hub/setup-io'
import { errorMessage } from '../setup-data'

interface Props {
  currentHub: string
  /** Called when the user leaves; `changed` = the hub setting moved this session. */
  onDone: (changed: boolean) => void
}

type Phase =
  | { name: 'input' }
  | { name: 'confirm'; newHub: string; count: number }
  | { name: 'working'; message: string }
  | { name: 'done'; changed: boolean; lines: string[]; warnings: string[] }
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
 * problem aborts with the old setting untouched.
 */
export function HubLocation({ currentHub, onDone }: Props): ReactNode {
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

      const lines = [`The hub is now ${newHub}.`]
      if (copyFrom !== null) lines.push(`The old folder ${copyFrom} was left untouched.`)
      lines.push('Open a new terminal for the change to apply everywhere.')
      setPhase({ name: 'done', changed: true, lines, warnings: hardcodedWarnings(newHub) })
    } catch (err: unknown) {
      setPhase({ name: 'failed', lines: ['The hub setting was NOT changed.', errorMessage(err)] })
    }
  }

  const onSubmit = (value: string): void => {
    const reason = validateHubParent(value)
    if (reason !== null) {
      setError(reason)
      return
    }
    setError('')

    const newHub = hubDirFromParent(value.trim())
    if (samePath(newHub, currentHub)) {
      if (existsSync(currentHub)) {
        setPhase({ name: 'done', changed: false, lines: [`The hub stays at ${currentHub}.`], warnings: [] })
      } else {
        // First run, the user kept the location the hub already resolves to
        // (the default, or the variable's value): it only has to exist —
        // there is no new setting to persist, so no setx.
        try {
          mkdirSync(currentHub, { recursive: true })
          setPhase({ name: 'done', changed: true, lines: [`Created the hub at ${currentHub}.`], warnings: [] })
        } catch (err: unknown) {
          setPhase({ name: 'failed', lines: [`Could not create ${currentHub}.`, errorMessage(err)] })
        }
      }
      return
    }

    if (isInside(newHub, currentHub) || isInside(currentHub, newHub)) {
      setError('The new hub cannot be inside the current one, or the other way around.')
      return
    }

    if (existsSync(currentHub)) {
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
        <Text dimColor>[enter] {ok ? 'back' : 'try again'}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold>Hub location</Text>
      <Text>Current hub: {currentHub}</Text>
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
