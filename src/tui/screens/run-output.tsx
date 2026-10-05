import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Box, Text, useInput, useWindowSize } from 'ink'

import type { RunResult } from '../screen'
import { errorMessage } from '../setup-data'

interface Props {
  title: string
  run: () => Promise<RunResult>
  onDone: () => void
}

/**
 * Runs one captured (non-interactive) job — sync, winget, a check — and shows
 * ✔/✘ plus the tail of its output. The keyboard is ignored until it finishes:
 * leaving mid-run would orphan a result nobody sees.
 */
export function RunOutput({ title, run, onDone }: Props): ReactNode {
  const [result, setResult] = useState<RunResult | null>(null)
  const started = useRef(false)
  const { rows } = useWindowSize()

  useEffect(() => {
    if (started.current) return
    started.current = true
    run()
      .then(setResult)
      .catch((error: unknown) => setResult({ ok: false, output: errorMessage(error) }))
  }, [run])

  useInput(
    (_input, key) => {
      if (key.return || key.escape) onDone()
    },
    { isActive: result !== null }
  )

  // Leave room for the title, the status line and the footer.
  const maxLines = Math.max(5, rows - 6)
  const lines = (result?.output ?? '').split(/\r?\n/)
  const shown = lines.slice(-maxLines)

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {result === null ? (
        <Text color="cyan">Running… this can take a while.</Text>
      ) : (
        <>
          <Text color={result.ok ? 'green' : 'red'}>{result.ok ? '✔ done' : '✘ failed'}</Text>
          {lines.length > shown.length && <Text dimColor>… {lines.length - shown.length} earlier lines hidden</Text>}
          {shown.map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
          <Text dimColor>[enter] back</Text>
        </>
      )}
    </Box>
  )
}
