import type { ReactNode } from 'react'
import { Text, useInput } from 'ink'

interface Props {
  question: string
  /** What a bare Enter means. Shown as `(Y/n)` or `(y/N)`. */
  defaultYes: boolean
  onAnswer: (yes: boolean) => void
}

/** A one-line yes/no prompt. Esc counts as "no". */
export function Confirm({ question, defaultYes, onAnswer }: Props): ReactNode {
  useInput((input, key) => {
    const answer = input.toLowerCase()
    if (answer === 'y') onAnswer(true)
    else if (answer === 'n' || key.escape) onAnswer(false)
    else if (key.return) onAnswer(defaultYes)
  })

  return (
    <Text>
      {question} <Text dimColor>{defaultYes ? '(Y/n)' : '(y/N)'}</Text>
    </Text>
  )
}
