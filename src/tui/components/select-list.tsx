import { useEffect, useState, type ReactNode } from 'react'
import { Box, Text, useInput } from 'ink'

/**
 * A row in a `SelectList`. `selectable: false` rows (section headers, notes)
 * are drawn but the cursor skips over them.
 */
export interface SelectItem {
  key: string
  label: ReactNode
  selectable?: boolean
}

interface Props {
  items: SelectItem[]
  onSelect: (item: SelectItem) => void
  onCancel?: () => void
  /** When false the list ignores the keyboard — another prompt owns it. */
  isActive?: boolean
  /** Restores the cursor to this row key after a refresh rebuilds `items`. */
  initialKey?: string
}

function isSelectable(item: SelectItem | undefined): boolean {
  return item !== undefined && item.selectable !== false
}

function firstSelectable(items: SelectItem[], preferredKey?: string): number {
  if (preferredKey !== undefined) {
    const preferred = items.findIndex((item) => item.key === preferredKey && isSelectable(item))
    if (preferred !== -1) return preferred
  }
  return Math.max(0, items.findIndex((item) => isSelectable(item)))
}

/** Next selectable index from `from` in `step` direction, or `from` itself when there is none. */
function move(items: SelectItem[], from: number, step: 1 | -1): number {
  for (let index = from + step; index >= 0 && index < items.length; index += step) {
    if (isSelectable(items[index])) return index
  }
  return from
}

/**
 * Up/down to move, Enter to pick, Esc to go back. Plain `useInput`, no extra
 * dependency; the highlighted row is drawn inverse.
 */
export function SelectList({ items, onSelect, onCancel, isActive = true, initialKey }: Props): ReactNode {
  const [index, setIndex] = useState(() => firstSelectable(items, initialKey))

  // `items` is rebuilt on every refresh; keep the cursor on a real, selectable row.
  useEffect(() => {
    setIndex((current) => (isSelectable(items[current]) ? current : firstSelectable(items, initialKey)))
  }, [items, initialKey])

  useInput(
    (_input, key) => {
      if (key.upArrow) setIndex((current) => move(items, current, -1))
      else if (key.downArrow) setIndex((current) => move(items, current, 1))
      else if (key.return) {
        const item = items[index]
        if (isSelectable(item) && item !== undefined) onSelect(item)
      } else if (key.escape) onCancel?.()
    },
    { isActive }
  )

  return (
    <Box flexDirection="column">
      {items.map((item, itemIndex) => {
        const highlighted = itemIndex === index && isSelectable(item) && isActive
        return (
          <Text key={item.key} inverse={highlighted}>
            {item.label}
          </Text>
        )
      })}
    </Box>
  )
}
