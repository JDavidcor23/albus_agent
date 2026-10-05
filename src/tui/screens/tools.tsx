import { useMemo, useState, type ReactNode } from 'react'
import { Box, Text, useInput } from 'ink'

import { Confirm } from '../components/confirm'
import { SelectList, type SelectItem } from '../components/select-list'
import { KNOWN_TOOLS, installTool } from '../../main/hub/setup-io'
import type { Screen } from '../screen'
import type { SetupData } from '../setup-data'

interface Props {
  data: SetupData | null
  onNavigate: (screen: Screen) => void
  onBack: () => void
}

/**
 * The missing tools of "This machine". A tool with a winget id can be
 * installed from here (after a confirm); one without shows the command the
 * user has to run themselves — `installTool` refuses to guess a package id.
 */
export function Tools({ data, onNavigate, onBack }: Props): ReactNode {
  const [confirming, setConfirming] = useState<string | null>(null)
  const [hint, setHint] = useState('')

  const missing = useMemo(() => (data?.tools ?? []).filter((tool) => !tool.present), [data])

  // The list owns Esc when it is drawn; with nothing missing there is no list.
  useInput(
    (_input, key) => {
      if (key.escape) onBack()
    },
    { isActive: missing.length === 0 }
  )

  const items = useMemo(
    (): SelectItem[] =>
      missing.map((tool) => {
        const known = KNOWN_TOOLS[tool.name]
        const how = known?.winget !== undefined ? `winget ${known.winget}` : 'manual install'
        return {
          key: tool.name,
          label: (
            <Text>
              <Text color="red">✘</Text> {tool.name} <Text dimColor>{how}</Text>
            </Text>
          )
        }
      }),
    [missing]
  )

  const onSelect = (item: SelectItem): void => {
    const known = KNOWN_TOOLS[item.key]
    if (known?.winget !== undefined) {
      setHint('')
      setConfirming(item.key)
    } else {
      setHint(known !== undefined ? `Install it yourself: ${known.hint}` : `Albus does not know how to install "${item.key}".`)
    }
  }

  const onAnswer = (yes: boolean): void => {
    const name = confirming
    setConfirming(null)
    if (!yes || name === null) return
    onNavigate({ name: 'output', title: `Install ${name}`, run: () => installTool(name), back: { name: 'tools' } })
  }

  return (
    <Box flexDirection="column">
      <Text bold>This machine — missing tools</Text>
      <Box marginY={1} flexDirection="column">
        {missing.length === 0 ? (
          <Text color="green">Every declared tool is installed.</Text>
        ) : (
          <SelectList items={items} onSelect={onSelect} onCancel={onBack} isActive={confirming === null} />
        )}
      </Box>
      {confirming !== null && (
        <Confirm
          question={`Install ${confirming} with winget (${KNOWN_TOOLS[confirming]?.winget ?? ''})?`}
          defaultYes={false}
          onAnswer={onAnswer}
        />
      )}
      {hint !== '' && <Text color="yellow">{hint}</Text>}
      <Text dimColor>[enter] install{'  '}[esc] back</Text>
    </Box>
  )
}
