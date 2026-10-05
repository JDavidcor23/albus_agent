/** Where the TUI is. `app.tsx` switches on `name`; screens navigate by handing one of these back. */

export interface RunResult {
  ok: boolean
  output: string
}

export type Screen =
  | { name: 'home' }
  | { name: 'agent'; id: string }
  | { name: 'hub' }
  | { name: 'tools' }
  | { name: 'output'; title: string; run: () => Promise<RunResult>; back: Screen }
