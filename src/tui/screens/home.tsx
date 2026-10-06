import { useMemo, type ReactNode } from 'react'
import { Box, Text, useApp, useInput } from 'ink'

import { Logo } from '../components/logo'
import { SelectList, type SelectItem } from '../components/select-list'
import type { Screen } from '../screen'
import { summarize, type SetupData, type TargetRow } from '../setup-data'
import { syncAgents } from '../sync-agents'

interface Props {
  data: SetupData | null
  loadError: string
  loading: boolean
  onNavigate: (screen: Screen) => void
  onRefresh: () => void
  /** Row key to put the cursor back on, e.g. the agent the user just left. */
  focusKey?: string
}

const HUB_KEY = 'hub'
const TOOLS_KEY = 'tools'

function mark(present: boolean): ReactNode {
  return present ? <Text color="green">✔</Text> : <Text color="red">✘</Text>
}

/** A non-selectable section header, same pattern as `agent-detail.tsx`'s. */
function sectionHeader(key: string, title: string): SelectItem {
  return { key, selectable: false, label: <Text bold>{title}</Text> }
}

function targetItem(row: TargetRow): SelectItem {
  const summary = summarize(row)
  return {
    key: `agent:${row.target.id}`,
    label: (
      <Text>
        {row.target.name} <Text dimColor>({row.target.id})</Text> <Text color={summary.color}>{summary.text}</Text>
      </Text>
    )
  }
}

export function Home({ data, loadError, loading, onNavigate, onRefresh, focusKey }: Props): ReactNode {
  const { exit } = useApp()

  useInput((input) => {
    if (input === 'q') exit()
    else if (input === 'r') onRefresh()
    else if (input === 's') {
      onNavigate({ name: 'output', title: 'Sync agents from GitHub', run: syncAgents, back: { name: 'home' } })
    }
  })

  const items = useMemo((): SelectItem[] => {
    const hubItem: SelectItem = {
      key: HUB_KEY,
      label: (
        <Text>
          <Text bold>Hub</Text>{'  '}{data?.hubDir ?? '…'}{'  '}<Text dimColor>[enter] change</Text>
        </Text>
      )
    }
    if (data === null) return [hubItem]

    const toolsItem: SelectItem = {
      key: TOOLS_KEY,
      label: (
        <Text>
          <Text bold>This machine</Text>{'  '}
          {data.tools.length === 0 ? (
            <Text dimColor>no tools declared</Text>
          ) : (
            data.tools.map((tool) => (
              <Text key={tool.name}>
                {mark(tool.present)} {tool.name}{' '}
              </Text>
            ))
          )}
        </Text>
      )
    }

    // Connections (providers: `provides` non-empty — Google, Notion,
    // WhatsApp, each configured ONCE here) come first, Agents (the
    // consumers) after. See `.claude/docs/agent-services.md`.
    const providerRows = data.rows.filter((row) => (row.target.manifest?.provides.length ?? 0) > 0)
    const agentRows = data.rows.filter((row) => (row.target.manifest?.provides.length ?? 0) === 0)

    const connectionItems: SelectItem[] = [
      sectionHeader('h:connections', 'Connections'),
      ...(providerRows.length === 0
        ? [{ key: 'n:connections', selectable: false, label: <Text dimColor>  none installed yet</Text> }]
        : providerRows.map(targetItem))
    ]
    const agentItems: SelectItem[] = [
      sectionHeader('h:agents', 'Agents'),
      ...(agentRows.length === 0
        ? [{ key: 'n:agents', selectable: false, label: <Text dimColor>  none installed yet</Text> }]
        : agentRows.map(targetItem))
    ]

    return [hubItem, toolsItem, ...connectionItems, ...agentItems]
  }, [data])

  const onSelect = (item: SelectItem): void => {
    if (item.key === HUB_KEY) onNavigate({ name: 'hub' })
    else if (item.key === TOOLS_KEY) onNavigate({ name: 'tools' })
    else if (item.key.startsWith('agent:')) onNavigate({ name: 'agent', id: item.key.slice('agent:'.length) })
  }

  return (
    <Box flexDirection="column">
      <Logo />
      <Box marginY={1}>
        <SelectList items={items} onSelect={onSelect} initialKey={focusKey} />
      </Box>
      {loading && <Text color="cyan">Loading…</Text>}
      {loadError !== '' && <Text color="red">{loadError}</Text>}
      <Text dimColor>[s] sync agents from GitHub{'  '}[r] refresh{'  '}[q] quit</Text>
    </Box>
  )
}
