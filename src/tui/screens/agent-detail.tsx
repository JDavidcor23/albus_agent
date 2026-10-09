import { useMemo, useState, type ReactNode } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'

import { Confirm } from '../components/confirm'
import { SelectList, type SelectItem } from '../components/select-list'
import { agentsHavingKey, type SetupStatus } from '../../core/hub/setup-status'
import { runAgentCheck, runAgentCommandInteractive, writeEnvValue } from '../../hub/setup-io'
import type { Screen } from '../screen'
import { errorMessage, type TargetRow } from '../setup-data'
import { stopReadingStdin } from '../terminal'

interface Props {
  id: string
  rows: TargetRow[]
  onNavigate: (screen: Screen) => void
  onBack: () => void
  onRefresh: () => void
}

type EnvItem = SetupStatus['env'][number]

type Mode =
  | { name: 'list' }
  | { name: 'reuse'; item: EnvItem; from: string }
  | { name: 'edit'; item: EnvItem }
  | { name: 'running' }

interface Message {
  text: string
  color: 'green' | 'red' | 'yellow'
}

const VALUE_PREVIEW_MAX = 40

function stateMark(state: 'ok' | 'missing' | 'optional-missing'): ReactNode {
  if (state === 'ok') return <Text color="green">✔</Text>
  if (state === 'optional-missing') return <Text dimColor>○</Text>
  return <Text color="red">✘</Text>
}

function header(key: string, title: string): SelectItem {
  return { key, selectable: false, label: <Text bold>{title}</Text> }
}

/** Why a `uses` entry is not `ok` — matches `UseFindingRow['status']` in `setup-data.ts`. */
function useReason(status: 'provider-not-installed' | 'not-granted' | 'provider-not-ready'): string {
  if (status === 'provider-not-installed') return 'provider not installed'
  if (status === 'not-granted') return 'provider does not grant this'
  return 'provider not ready — finish its setup in Connections'
}

/**
 * One target's setup: Keys / Permissions / Commands / Check.
 *
 * SECRETS: a secret value is never rendered (only `set`), never logged, never
 * put in a message. Reusing another agent's key copies the value straight
 * from that agent's parsed env into `writeEnvValue` — it never passes
 * through anything that draws.
 */
export function AgentDetail({ id, rows, onNavigate, onBack, onRefresh }: Props): ReactNode {
  const { suspendTerminal } = useApp()
  const [mode, setMode] = useState<Mode>({ name: 'list' })
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState<Message | null>(null)

  const row = rows.find((candidate) => candidate.target.id === id)
  const target = row?.target
  const manifest = target?.manifest ?? null
  const status = row?.status ?? null

  // Esc while typing a key cancels the edit; the list and Confirm own Esc otherwise.
  useInput(
    (_input, key) => {
      if (key.escape) {
        setDraft('')
        setMode({ name: 'list' })
        setMessage({ text: 'Cancelled.', color: 'yellow' })
      }
    },
    { isActive: mode.name === 'edit' }
  )

  // A broken target has no list to own Esc.
  useInput(
    (_input, key) => {
      if (key.escape) onBack()
    },
    { isActive: manifest === null || status === null }
  )

  const items = useMemo((): SelectItem[] => {
    if (row === undefined || manifest === null || status === null) return []
    const result: SelectItem[] = []

    if (row.uses.length > 0) {
      result.push(header('h:uses', 'Uses'))
      for (const use of row.uses) {
        const reason = use.status === 'ok' ? '' : useReason(use.status)
        result.push({
          key: `use:${use.use}`,
          selectable: false,
          label: (
            <Text>
              {'  '}
              {reason === '' ? <Text color="green">✔</Text> : <Text color="red">✘</Text>} {use.use}
              {reason !== '' && <Text dimColor> — {reason}</Text>}
            </Text>
          )
        })
      }
    }

    result.push(header('h:keys', 'Keys'))
    if (status.env.length === 0) result.push({ key: 'n:keys', selectable: false, label: <Text dimColor>  none declared</Text> })
    for (const item of status.env) {
      const value = row.facts.envValues.get(item.key) ?? ''
      let shown: ReactNode
      if (item.state !== 'ok') shown = <Text dimColor>{item.state === 'optional-missing' ? 'optional' : 'missing'}</Text>
      else if (item.secret) shown = <Text color="green">set</Text>
      else shown = <Text color="green">{value.length > VALUE_PREVIEW_MAX ? `${value.slice(0, VALUE_PREVIEW_MAX)}…` : value}</Text>
      result.push({
        key: `env:${item.key}`,
        label: (
          <Text>
            {'  '}
            {stateMark(item.state)} {item.key} <Text dimColor>{item.label}</Text> {shown}
          </Text>
        )
      })
    }

    result.push(header('h:auth', 'Permissions'))
    if (status.auth.length === 0) result.push({ key: 'n:auth', selectable: false, label: <Text dimColor>  none declared</Text> })
    status.auth.forEach((item, index) => {
      result.push({
        key: `auth:${index}`,
        label: (
          <Text>
            {'  '}
            {stateMark(item.state)} {item.label} <Text dimColor>runs "{item.command}"</Text>
          </Text>
        )
      })
    })

    const commandNames = Object.keys(manifest.commands).filter((name) => name !== 'run')
    result.push(header('h:cmd', 'Commands'))
    if (commandNames.length === 0) result.push({ key: 'n:cmd', selectable: false, label: <Text dimColor>  none declared</Text> })
    for (const name of commandNames) {
      result.push({
        key: `cmd:${name}`,
        label: (
          <Text>
            {'  '}▸ {name} <Text dimColor>{manifest.commands[name]}</Text>
          </Text>
        )
      })
    }

    result.push(header('h:check', 'Check'))
    if (manifest.commands.check === undefined) {
      result.push({ key: 'n:check', selectable: false, label: <Text dimColor>  no "check" command declared</Text> })
    } else {
      result.push({ key: 'check', label: <Text>{'  '}▸ run the check</Text> })
    }

    return result
  }, [row, manifest, status])

  if (row === undefined || target === undefined) {
    return (
      <Box flexDirection="column">
        <Text color="red">"{id}" is no longer in the hub.</Text>
        <SelectList items={[{ key: 'back', label: 'Back' }]} onSelect={onBack} onCancel={onBack} />
      </Box>
    )
  }

  /**
   * Leaving Ink for an interactive command (an OAuth flow, a login): Ink owns
   * stdin in raw mode, so the child would otherwise get no keystrokes, or
   * fight Ink for them. Ink 8's `suspendTerminal` is the built-in for exactly
   * this — it erases the frame, turns raw mode off, detaches Ink's stdin
   * listener and stops drawing until the callback settles, then re-takes the
   * terminal and forces a full redraw (even if the callback throws).
   *
   * That alone is NOT enough on Windows — verified in a real console: the
   * child's prompt got an empty line and the typed text vanished, because
   * this process still had a console read pending and won the race for the
   * keystrokes. `stopReadingStdin` closes that read before the child starts;
   * Ink's resume re-attaches its listener, which restarts reading. The child
   * itself gets `stdio: 'inherit'` (see `runAgentCommandInteractive`).
   */
  const runInteractive = async (commandName: string): Promise<void> => {
    setMessage(null)
    setMode({ name: 'running' })
    let code: number | null = null
    let failure = ''
    try {
      await suspendTerminal(async () => {
        await stopReadingStdin()
        process.stdout.write(`\n▶ ${target.name}: ${commandName}. Albus setup comes back when it exits.\n\n`)
        try {
          code = await runAgentCommandInteractive(target, commandName)
        } catch (error: unknown) {
          failure = errorMessage(error)
        }
        process.stdout.write(`\n◀ ${commandName} ${failure !== '' ? 'could not start' : `exited with code ${code}`}\n\n`)
      })
    } catch (error: unknown) {
      failure = errorMessage(error)
    }
    setMode({ name: 'list' })
    if (failure !== '') setMessage({ text: failure, color: 'red' })
    else setMessage({ text: `${commandName} exited with code ${code}.`, color: code === 0 ? 'green' : 'red' })
    // Re-reads the doneWhen files: a permission flow that worked flips to ✔ here.
    onRefresh()
  }

  const saveKey = (item: EnvItem, value: string): void => {
    if (manifest === null) return
    try {
      writeEnvValue(target.dir, manifest.setup.envFile, item.key, value)
      setMessage({ text: `Saved ${item.key}.`, color: 'green' })
      onRefresh()
    } catch (error: unknown) {
      setMessage({ text: errorMessage(error), color: 'red' })
    }
  }

  const startKey = (item: EnvItem): void => {
    setMessage(null)
    setDraft('')
    if (item.state !== 'ok') {
      const values = rows
        .filter((candidate) => candidate.target.manifest !== null)
        .map((candidate) => ({ agentId: candidate.target.id, env: candidate.facts.envValues }))
      const others = agentsHavingKey(item.key, values, target.id)
      const from = others[0]
      if (from !== undefined) {
        setMode({ name: 'reuse', item, from })
        return
      }
    }
    setMode({ name: 'edit', item })
  }

  const onReuseAnswer = (item: EnvItem, from: string, yes: boolean): void => {
    if (!yes) {
      setMode({ name: 'edit', item })
      return
    }
    setMode({ name: 'list' })
    const value = rows.find((candidate) => candidate.target.id === from)?.facts.envValues.get(item.key)
    if (value === undefined || value === '') {
      setMessage({ text: `${item.key} is no longer set in ${from}.`, color: 'red' })
      return
    }
    saveKey(item, value)
  }

  const onSubmitKey = (item: EnvItem, raw: string): void => {
    const value = raw.trim()
    setDraft('')
    setMode({ name: 'list' })
    if (value === '') {
      setMessage({ text: 'Cancelled.', color: 'yellow' })
      return
    }
    saveKey(item, value)
  }

  const onSelect = (selected: SelectItem): void => {
    if (status === null || manifest === null) return
    const { key } = selected
    if (key.startsWith('env:')) {
      const item = status.env.find((candidate) => candidate.key === key.slice('env:'.length))
      if (item !== undefined) startKey(item)
    } else if (key.startsWith('auth:')) {
      const item = status.auth[Number(key.slice('auth:'.length))]
      if (item !== undefined) void runInteractive(item.command)
    } else if (key.startsWith('cmd:')) {
      void runInteractive(key.slice('cmd:'.length))
    } else if (key === 'check') {
      onNavigate({
        name: 'output',
        title: `Check — ${target.name}`,
        run: () => runAgentCheck(target),
        back: { name: 'agent', id: target.id }
      })
    }
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{target.name}</Text> <Text dimColor>({target.id})</Text>
      </Text>
      <Text dimColor>{target.dir}</Text>
      {target.problem !== '' && <Text color="red">broken: {target.problem}</Text>}

      {manifest !== null && status !== null && (
        <Box marginY={1}>
          <SelectList items={items} onSelect={onSelect} onCancel={onBack} isActive={mode.name === 'list'} />
        </Box>
      )}

      {mode.name === 'reuse' && (
        <Confirm
          question={`${mode.item.key} is already set in ${mode.from}. Use the same value?`}
          defaultYes
          onAnswer={(yes) => onReuseAnswer(mode.item, mode.from, yes)}
        />
      )}

      {mode.name === 'edit' && (
        <Box flexDirection="column">
          {mode.item.help !== '' && <Text dimColor>{mode.item.help}</Text>}
          <Box>
            <Text>{mode.item.key}: </Text>
            <TextInput
              value={draft}
              onChange={setDraft}
              onSubmit={(value) => onSubmitKey(mode.item, value)}
              mask={mode.item.secret ? '*' : undefined}
            />
          </Box>
          <Text dimColor>[enter] save (empty = cancel){'  '}[esc] cancel</Text>
        </Box>
      )}

      {mode.name === 'running' && <Text color="cyan">Running…</Text>}
      {message !== null && <Text color={message.color}>{message.text}</Text>}
      {mode.name === 'list' && <Text dimColor>[enter] set / run{'  '}[esc] back</Text>}
    </Box>
  )
}
