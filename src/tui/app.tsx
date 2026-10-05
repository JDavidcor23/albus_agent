import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Box } from 'ink'

import { currentHubDir } from '../main/hub/setup-io'
import type { Screen } from './screen'
import { AgentDetail } from './screens/agent-detail'
import { Home } from './screens/home'
import { HubLocation } from './screens/hub-location'
import { RunOutput } from './screens/run-output'
import { Tools } from './screens/tools'
import { errorMessage, loadSetupData, type SetupData } from './setup-data'

interface Props {
  initialScreen: Screen
}

/**
 * The screen switch. Owns the one data snapshot every screen draws from and
 * reloads it whenever the user comes back to Home or an agent, so what is
 * shown is never older than the last thing the user did.
 */
export function App({ initialScreen }: Props): ReactNode {
  const [screen, setScreen] = useState<Screen>(initialScreen)
  const [hubDir, setHubDir] = useState(currentHubDir)
  const [data, setData] = useState<SetupData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [homeFocus, setHomeFocus] = useState<string | undefined>(undefined)
  // Only the newest load may land: an older, slower one must not overwrite it.
  const loadId = useRef(0)

  const refresh = useCallback((): void => {
    const id = ++loadId.current
    setLoading(true)
    loadSetupData(hubDir)
      .then((loaded) => {
        if (id !== loadId.current) return
        setData(loaded)
        setLoadError('')
      })
      .catch((error: unknown) => {
        if (id === loadId.current) setLoadError(`Could not read the hub: ${errorMessage(error)}`)
      })
      .finally(() => {
        if (id === loadId.current) setLoading(false)
      })
  }, [hubDir])

  useEffect(refresh, [refresh])

  const navigate = useCallback(
    (next: Screen): void => {
      if (next.name === 'home' || next.name === 'agent') refresh()
      setScreen(next)
    },
    [refresh]
  )

  const goHome = useCallback((): void => navigate({ name: 'home' }), [navigate])

  let content: ReactNode
  switch (screen.name) {
    case 'home':
      content = (
        <Home
          data={data}
          loading={loading}
          loadError={loadError}
          onRefresh={refresh}
          focusKey={homeFocus}
          onNavigate={(next) => {
            if (next.name === 'agent') setHomeFocus(`agent:${next.id}`)
            else if (next.name === 'hub') setHomeFocus('hub')
            else if (next.name === 'tools') setHomeFocus('tools')
            navigate(next)
          }}
        />
      )
      break
    case 'agent':
      content = (
        <AgentDetail
          key={screen.id}
          id={screen.id}
          rows={data?.rows ?? []}
          onNavigate={navigate}
          onBack={goHome}
          onRefresh={refresh}
        />
      )
      break
    case 'hub':
      content = (
        <HubLocation
          currentHub={hubDir}
          onDone={(changed) => {
            // `setHubDirPersistently` already moved `process.env` for this
            // run; re-resolving picks it up and the hubDir change reloads.
            const next = currentHubDir()
            if (changed && next !== hubDir) setHubDir(next)
            else refresh()
            setScreen({ name: 'home' })
          }}
        />
      )
      break
    case 'tools':
      content = <Tools data={data} onNavigate={navigate} onBack={goHome} />
      break
    case 'output':
      content = (
        <RunOutput
          title={screen.title}
          run={screen.run}
          onDone={() => {
            const back = screen.back
            // Whatever ran (sync, install, check) may have changed the disk.
            refresh()
            setScreen(back)
          }}
        />
      )
      break
  }

  return <Box flexDirection="column">{content}</Box>
}
