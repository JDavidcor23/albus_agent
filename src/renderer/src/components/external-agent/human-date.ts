/**
 * "Today, 6:56 AM" / "Yesterday, 8:26 PM" / "Sep 29" (+ year if not this one).
 *
 * "Today"/"Yesterday" are hardcoded English words per the project's UI-copy
 * convention; everything else (the time, the month name) goes through `Intl`
 * with the viewer's own locale so it still reads right outside en-US.
 */
export function humanDateSmart(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''

  const now = new Date()
  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diffDays = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)

  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at)
  if (diffDays === 0) return `Today, ${time}`
  if (diffDays === 1) return `Yesterday, ${time}`

  const sameYear = at.getFullYear() === now.getFullYear()
  return new Intl.DateTimeFormat(
    undefined,
    sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }
  ).format(at)
}
