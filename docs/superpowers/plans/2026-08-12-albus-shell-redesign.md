# Rediseño del shell de Albus — plan de implementación

> **Para workers agénticos:** SUB-SKILL REQUERIDA: usar `superpowers:subagent-driven-development` (recomendado) o `superpowers:executing-plans` para implementar tarea por tarea. Los pasos usan checkbox (`- [ ]`).

**Goal:** Albus deja de ser cuatro pestañas hermanas y pasa a ser una conversación con un rail al costado, en inglés, con Settings propio y sin desbordarse en pantallas chicas.

**Architecture:** Cambio de renderer, más los strings del main que el usuario lee. `App.tsx` deja de ser "tabs + panel" y pasa a "rail + superficie". `LeftPanel` se disuelve: su identidad va al rail, sus controles de worker a la vista de extracciones y su `CliPicker` a Settings. Ningún canal de IPC cambia.

**Tech Stack:** Electron 33 · React 19 · TypeScript 5.5 · CSS plano en una sola hoja (`main.css`) · zod 4 en el main.

**Spec:** `docs/superpowers/specs/2026-08-12-albus-shell-redesign-design.md`

## Global Constraints

- **No se escriben tests.** Este proyecto no tiene runner ni linter. El gate es `npm run typecheck` (corre `typecheck:node` y `typecheck:web`). Los pasos de TDD de la skill de planificación no aplican acá — instrucción explícita del usuario.
- **Se traduce lo que el usuario LEE. No se toca ningún valor que el sistema COMPARA.** Lista completa de valores prohibidos en la sección "Contratos congelados" de este plan.
- **Código nuevo en inglés.** A partir de la Tarea 1, también el copy de UI y los comentarios nuevos. Los comentarios existentes en español se dejan como están salvo que el archivo se reescriba entero.
- Una sola hoja de estilos: `src/renderer/src/assets/main.css`. No se crean archivos CSS nuevos.
- El renderer nunca importa de `src/main/**`. Solo `window.api` y tipos de `src/shared/ipc`.
- Toda respuesta de `window.api` es `{ok:true,data} | {ok:false,error:{code,message}}`. Se maneja el sobre, nunca se asume `data`.
- Commits convencionales. **Sin `Co-Authored-By` ni atribución a IA.**

## Contratos congelados — NUNCA traducir

Si alguno de estos valores aparece cambiado en un diff, la tarea está mal aunque compile:

| Valor | Rompe |
|---|---|
| `'pagos'`, `'qr-eventos'`, `'contactos'`, `'info'`, `'sin-clasificar'` | Drive crea carpetas vacías y abandona los archivos viejos |
| `'post link'` y todo nombre de propiedad u opción de Notion | el upsert se vuelve insert; Notion inventa columnas |
| `trabaja_en`, `conoci_en`, `organiza`, `pagado_a`, `trata_de`, `enlaza_a` | el grafo se parte en aristas viejas y nuevas |
| `'## Respuestas a lo que el agente preguntó'` y el formato de su viñeta | la sección se duplica; las respuestas dejan de verse |
| `albus_agent/`, `agents/`, `graphify/`, `albus.yml`, `connections.json`, `<id>.agente.json`, `<id>.preguntas.json` | se abandona el estado del usuario |
| `'albus-agent'` (`userData`), `'persist:albus-jobs'` | hay que volver a loguearse en LinkedIn y Google |
| los 13 headers de `COLUMNS`, `albus-profile.json`, `seen_jobs.json` | contrato con el workspace |
| los `id` de `src/main/connections/registry.ts` | son las claves de `connections.json` |

Los `name`, `purpose` y `detail` de ese mismo registry **sí** son copy y se traducen.

---

### Task 1: Fundaciones — la convención y el scroll

Lo primero porque todo lo que sigue escribe copy en inglés, y porque el desborde es el dolor diario.

**Files:**
- Modify: `CLAUDE.md` (la línea de convención de idioma)
- Modify: `src/renderer/src/assets/main.css:126-163` (`.app-container`, `.panel-left`, `.panel-right`)

**Interfaces:**
- Consumes: nada
- Produces: la convención de idioma en inglés, que rige las Tareas 2–5. Las clases `.app-container`, `.panel-left` y `.panel-right` siguen existiendo con los mismos nombres; la Tarea 3 las reemplaza.

- [ ] **Step 1: Cambiar la convención en `CLAUDE.md`**

Buscar la línea:

```markdown
- **Código nuevo en inglés; comentarios y copy de UI en español.** Deliberado.
```

Reemplazar por:

```markdown
- **Todo en inglés: código, copy de UI y comentarios nuevos.** Cambió el
  2026-08-12. Antes el copy iba en español. Los comentarios viejos en español
  se dejan; se traducen solo si se reescribe el archivo entero. **Los valores
  congelados de la tabla de arriba NO son copy y siguen en español para
  siempre** — son dato que el sistema compara.
```

- [ ] **Step 2: Arreglar el desborde del panel izquierdo**

En `src/renderer/src/assets/main.css`, reemplazar el bloque `.app-container`:

```css
.app-container {
  display: flex;
  /* 100vw incluye la barra de scroll y con escalado de Windows queda unos
     píxeles más ancho que el área de contenido. 100% mide contra el padre. */
  width: 100%;
  height: 100%;
  background: radial-gradient(
    circle at 10% 8%,
    rgba(201, 151, 63, 0.08) 0%,
    rgba(201, 151, 63, 0.02) 30%,
    transparent 65%
  ), var(--ground);
  /* Fijos en 2.5rem/3rem, en una ventana de 900px se comían un tercio del
     ancho útil. Con clamp la ventana chica respira y la grande no cambia. */
  padding: clamp(1rem, 2.4vw, 2.5rem);
  gap: clamp(1.25rem, 3vw, 3rem);
  /* Sin esto, un hijo flex nunca baja de su altura de contenido y el
     overflow-y de los hijos no se activa nunca. */
  min-height: 0;
}
```

Y el bloque `.panel-left`:

```css
.panel-left {
  /* No crece ni se estira, pero sí puede encogerse en ventanas angostas. */
  flex: 0 1 320px;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  border-right: 1px solid var(--line);
  padding-right: clamp(1rem, 2vw, 2.5rem);
  /* El bug: sin esto el contenido que no entra queda fuera de alcance,
     porque html/body tienen overflow:hidden. */
  min-height: 0;
  overflow-y: auto;
}
```

Y agregar `min-height: 0` a `.panel-right`, que ya tiene `overflow-y: auto`:

```css
.panel-right {
  flex: 1;
  /* Sin esto un hijo flex no baja de su ancho de contenido y desborda el shell. */
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding-right: 0.5rem;
}
```

- [ ] **Step 3: Verificar que compila**

```bash
npm run typecheck
```

Esperado: sin errores.

- [ ] **Step 4: Verificar el scroll a ojo**

```bash
npm run dev
```

Achicar la ventana hasta ~900×600. Esperado: el panel izquierdo tiene su propia barra de scroll y se llega al pie (`albus agent // worker local`). Antes quedaba cortado sin forma de alcanzarlo.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md src/renderer/src/assets/main.css
git commit -m "fix(ui): el panel izquierdo scrollea y el shell respira en ventanas chicas"
```

---

### Task 2: Settings — conexiones y CLI salen de donde no van

**Files:**
- Create: `src/renderer/src/components/SettingsPanel.tsx`
- Modify: `src/renderer/src/components/CliPicker.tsx` (reescritura completa)
- Modify: `src/renderer/src/components/JobChat.tsx` (sacar `ConnectionsPanel` y su botón)
- Modify: `src/renderer/src/assets/main.css` (clases `.settings-*`, `.cli-*`)
- Modify: `src/main/devtools/ui-selftest.ts` (los asserts que rompe este cambio)

**Interfaces:**
- Consumes: de la Tarea 1, nada de código — solo la convención de idioma.
- Produces:
  - `SettingsPanel`, con props `{ providers: CliProviderInfo[]; providerId: string | null; modelId: string | null; refreshing: boolean; loading: boolean; onCliChange: (providerId: string | null, modelId: string | null) => void; onRefreshCli: () => void; onError: (m: string | null) => void }`
  - `CliPicker` cambia de firma: pierde `disabled` y `onRefresh`/`refreshing` pasan a ser obligatorios. Nueva firma exacta en el Step 2.
  - La Tarea 3 monta `SettingsPanel` en el rail con esas props.

- [ ] **Step 1: Reescribir `CliPicker.tsx`**

El problema actual: proveedores y modelos se pintan como dos filas de texto separadas por `·`, sin etiqueta que diga cuál es cuál. Se lee como ruido. Se mantiene el dibujo en texto (un `<select>` nativo mete tipografía y chevron de Windows en una pantalla que no tiene nada nativo), pero cada fila recibe su etiqueta y el bloque se ordena.

Reemplazar el archivo entero:

```tsx
import type { CliProviderInfo } from '../../../shared/ipc'

interface Props {
  providers: CliProviderInfo[]
  providerId: string | null
  modelId: string | null
  refreshing: boolean
  loading: boolean
  onChange: (providerId: string | null, modelId: string | null) => void
  onRefresh: () => void
}

/** How the CLI reported its models. Shown so a stale list is explainable. */
const HOW: Record<string, string> = {
  seed: 'unverified candidates',
  listed: 'listed by the CLI',
  probed: 'probed one by one',
  cached: 'from cache'
}

/**
 * Which CLI runs step 4 of the cascade, and with which model.
 *
 * Drawn as text and not with native controls: a Windows <select> drags its own
 * typeface and chevron into a screen that has nothing native in it.
 *
 * The provider list is NOT hardcoded — it is whatever `listCliProviders` found
 * on the PATH. Today that is one entry because one CLI is installed.
 */
export function CliPicker({
  providers,
  providerId,
  modelId,
  refreshing,
  loading,
  onChange,
  onRefresh
}: Props): React.JSX.Element {
  const current = providers.find((p) => p.id === providerId) ?? null

  if (loading) return <p className="cli-hint">looking for CLIs…</p>

  if (providers.length === 0) {
    return <p className="cli-hint">no CLI on the PATH — step 4 of the cascade is off</p>
  }

  return (
    <div className="cli-picker">
      <div className="cli-field">
        <span className="cli-field-label">CLI</span>
        <div className="cli-field-value" role="radiogroup" aria-label="CLI">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={providerId === p.id}
              className={`pick ${providerId === p.id ? 'pick-on' : ''}`}
              onClick={() => onChange(p.id, p.models[0]?.id ?? null)}
            >
              {p.id}
            </button>
          ))}
        </div>
      </div>

      {current !== null && current.models.length > 0 && (
        <div className="cli-field">
          <span className="cli-field-label">Model</span>
          <div className="cli-field-value" role="radiogroup" aria-label="Model">
            {current.models.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={(modelId ?? current.models[0].id) === m.id}
                className={`pick ${(modelId ?? current.models[0].id) === m.id ? 'pick-on' : ''}`}
                onClick={() => onChange(current.id, m.id)}
              >
                {m.id}
              </button>
            ))}
          </div>
        </div>
      )}

      {current !== null && (
        <p className="cli-hint">
          {current.models.length} models · {HOW[current.method] ?? current.method} ·{' '}
          {current.cliVersion}
        </p>
      )}

      <p className="cli-hint">only used for what QR, OCR and patterns could not resolve</p>

      <button type="button" className="pick cli-refresh" disabled={refreshing} onClick={onRefresh}>
        {refreshing ? 'probing every model…' : 'verify models'}
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Crear `SettingsPanel.tsx`**

```tsx
import type { CliProviderInfo } from '../../../shared/ipc'
import { CliPicker } from './CliPicker'
import { ConnectionsPanel } from './ConnectionsPanel'

interface Props {
  providers: CliProviderInfo[]
  providerId: string | null
  modelId: string | null
  refreshing: boolean
  loading: boolean
  onCliChange: (providerId: string | null, modelId: string | null) => void
  onRefreshCli: () => void
  onError: (m: string | null) => void
}

/**
 * App-level configuration.
 *
 * Connections used to live inside the job agent's chat. Google, Drive and
 * Notion belong to Albus, not to one agent — burying them there meant the next
 * agent would have had to grow its own copy.
 */
export function SettingsPanel({
  providers,
  providerId,
  modelId,
  refreshing,
  loading,
  onCliChange,
  onRefreshCli,
  onError
}: Props): React.JSX.Element {
  return (
    <div className="settings">
      <section className="settings-block">
        <h2 className="settings-title">Connections</h2>
        <p className="settings-sub">
          A window opens, you sign in, Albus keeps the session. Nothing to configure by hand.
        </p>
        <ConnectionsPanel onChange={() => undefined} onError={onError} />
      </section>

      <section className="settings-block">
        <h2 className="settings-title">Engine</h2>
        <p className="settings-sub">
          Which CLI answers when the cheap steps of the cascade come up empty.
        </p>
        <CliPicker
          providers={providers}
          providerId={providerId}
          modelId={modelId}
          refreshing={refreshing}
          loading={loading}
          onChange={onCliChange}
          onRefresh={onRefreshCli}
        />
      </section>
    </div>
  )
}
```

- [ ] **Step 3: Sacar las conexiones de `JobChat.tsx`**

En `src/renderer/src/components/JobChat.tsx`:

1. Borrar el import `import { ConnectionsPanel } from './ConnectionsPanel'`.
2. Borrar la línea `{showConnections && <ConnectionsPanel onChange={refreshStatus} onError={onError} />}` (cerca de la línea 483).
3. Borrar el estado `showConnections` y su `setShowConnections`, y el botón con clase `job-conexiones-btn` que lo alterna.
4. Donde el botón avisaba que faltaban conexiones, dejar en su lugar un aviso que apunte a Settings, sin botón propio:

```tsx
{falta > 0 && (
  <span className="job-setup-falta">
    {falta} connection{falta === 1 ? '' : 's'} missing — Settings
  </span>
)}
```

Usar el mismo valor que hoy alimenta el contador de `job-conexiones-estado`. Si `refreshStatus` queda sin llamadores tras quitar el panel, dejarlo: lo sigue usando el resto del componente. Si el `typecheck` lo marca como no usado, borrarlo.

- [ ] **Step 4: Estilos de Settings**

Agregar al final de `src/renderer/src/assets/main.css`:

```css
/* ── settings ────────────────────────────────────────────────────────────
   App-level configuration. One column, generous spacing: this screen is
   read once in a while, not scanned every day.
   ---------------------------------------------------------------------- */

.settings {
  display: flex;
  flex-direction: column;
  gap: 28px;
  padding: 4px 2px 24px;
  /* Its own scroll: the connection step log can get long. */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.settings-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.settings-title {
  font-family: var(--font-serif);
  font-size: 1.4rem;
  font-weight: 400;
  color: var(--ink);
}

.settings-sub {
  margin-top: -6px;
  font-size: 0.78rem;
  color: var(--muted);
}

/* The picker stops being a soup of dot-separated words: each row gets a
   label, so you can tell the CLI from the model without guessing. */
.cli-field {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 5px 0;
}

.cli-field-label {
  flex: 0 0 4.5rem;
  font-size: 0.68rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
}

.cli-field-value {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  min-width: 0;
}
```

En el mismo archivo, quitar el `border-top` y el `margin` superior de `.cli-picker`, que existían para separarlo de la marca en el panel izquierdo y ahora sobran:

```css
.cli-picker {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
```

- [ ] **Step 5: Actualizar los asserts que este cambio rompe**

`src/main/devtools/ui-selftest.ts` clickea `.job-conexiones-btn`, que ya no existe. En ese archivo:

1. Borrar el paso que hace `document.querySelector('.job-conexiones-btn').click()` (cerca de la línea 170) y el `hasConnections` / texto del botón que lee (líneas 64-68).
2. Reemplazar ese click por la navegación al rail de Settings. **Ese selector lo crea la Tarea 3**, así que en esta tarea el assert de conexiones se comenta con el motivo:

```ts
// Conexiones se movieron a Settings (Tarea 2). El assert vuelve en la Tarea 3,
// cuando exista el rail que las alcanza: `.rail-item[data-view="settings"]`.
```

Los asserts de `.conexion-grupo`, `.conexion-nombre` y `.conexion-para` se dejan como están: esos nodos siguen existiendo, solo cambiaron de padre.

- [ ] **Step 6: Verificar**

```bash
npm run typecheck
```

Esperado: sin errores. `SettingsPanel` todavía no está montado en ninguna pantalla — eso es la Tarea 3. Compila igual porque es un módulo exportado que nadie importa.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/SettingsPanel.tsx src/renderer/src/components/CliPicker.tsx src/renderer/src/components/JobChat.tsx src/renderer/src/assets/main.css src/main/devtools/ui-selftest.ts
git commit -m "feat(ui): las conexiones y el CLI pasan a ser configuración de la app"
```

---

### Task 3: El rail — la conversación al frente

**Files:**
- Create: `src/renderer/src/components/Rail.tsx`
- Delete: `src/renderer/src/components/LeftPanel.tsx`
- Modify: `src/renderer/src/App.tsx` (reescritura completa)
- Modify: `src/renderer/src/components/ResultsFeed.tsx` (recibe los controles del worker)
- Modify: `src/renderer/src/assets/main.css` (clases `.rail-*`)
- Modify: `src/main/devtools/ui-selftest.ts`

**Interfaces:**
- Consumes: `SettingsPanel` de la Tarea 2, con la firma exacta de props declarada ahí.
- Produces:
  - Tipo `View = 'chat' | 'extractions' | 'graph' | 'tasks' | 'settings'`, exportado desde `Rail.tsx`.
  - `Rail`, con props `{ view: View; onView: (v: View) => void; providerId: string | null; modelId: string | null; total: number }`.
  - Cada entrada del rail lleva `data-view="<View>"` — es el selector que usa `ui-selftest`.
  - `ResultsFeed` gana props `{ processing: boolean; progress: { done: number; total: number } | null; onProcess: () => void; onReprocess: () => void }` sumadas a las que ya tiene.

- [ ] **Step 1: Crear `Rail.tsx`**

```tsx
export type View = 'chat' | 'extractions' | 'graph' | 'tasks' | 'settings'

interface Props {
  view: View
  onView: (v: View) => void
  providerId: string | null
  modelId: string | null
  total: number
}

/** The secondary group. Reachable, but visibly lighter than the conversation. */
const SECONDARY: { id: View; label: string }[] = [
  { id: 'extractions', label: 'Extractions' },
  { id: 'graph', label: 'Graph' },
  { id: 'tasks', label: 'Tasks' }
]

/**
 * Identity plus navigation.
 *
 * The conversation is the app; everything else is a place you go when you need
 * it. These three stay in the rail on purpose — the logic that would offer them
 * from inside the conversation is a separate project, and without it they would
 * simply be unreachable.
 */
export function Rail({ view, onView, providerId, modelId, total }: Props): React.JSX.Element {
  return (
    <aside className="panel-left">
      <div>
        <h1 className="brand-title">Albus</h1>
        <div className="brand-subtitle">your agents, one conversation</div>

        <nav className="rail-nav">
          <button
            type="button"
            data-view="chat"
            className={`rail-item rail-item-main ${view === 'chat' ? 'rail-item-on' : ''}`}
            onClick={() => onView('chat')}
          >
            Chat
          </button>

          <div className="rail-group">
            {SECONDARY.map((s) => (
              <button
                key={s.id}
                type="button"
                data-view={s.id}
                className={`rail-item ${view === s.id ? 'rail-item-on' : ''}`}
                onClick={() => onView(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </nav>
      </div>

      <div className="rail-foot">
        {/*
          The active model, read-only. It lives in Settings, but you should not
          have to open Settings to know what is answering.
        */}
        <button
          type="button"
          data-view="settings"
          className={`rail-item rail-status ${view === 'settings' ? 'rail-item-on' : ''}`}
          onClick={() => onView('settings')}
        >
          <span className="rail-status-line">{providerId ?? 'no CLI'}</span>
          <span className="rail-status-sub">{modelId ?? '—'}</span>
          <span className="rail-status-gear">Settings</span>
        </button>

        <div className="footer-meta">
          {total > 0 ? `${total} extracted` : 'albus agent // local worker'}
        </div>
      </div>
    </aside>
  )
}
```

- [ ] **Step 2: Mover los controles del worker a `ResultsFeed.tsx`**

`procesar lote` y `reprocesar todo` son controles del worker de extracción, no identidad de la app. Agregar a las props existentes de `ResultsFeed`:

```tsx
  processing: boolean
  progress: { done: number; total: number } | null
  onProcess: () => void
  onReprocess: () => void
```

Y arriba del feed, antes de la lista, renderizar la barra que hoy vive en `LeftPanel`:

```tsx
<div className="feed-bar">
  <button type="button" className="btn-brass" onClick={onProcess} disabled={processing}>
    {processing ? 'processing…' : 'process batch'}
  </button>
  <button type="button" className="btn-ghost" onClick={onReprocess} disabled={processing}>
    reprocess everything
  </button>

  {processing && progress !== null && (
    <div className="progress-block">
      <div className="progress-track">
        <div
          className="progress-fill"
          style={{
            width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%`
          }}
        />
      </div>
      <div className="progress-meta">
        {progress.done} / {progress.total}
      </div>
      <p className="processing-hint">
        OCR looks at every image carefully. Several seconds per file.
      </p>
    </div>
  )}
</div>
```

`.btn-brass` tiene `width: 100%`, pensado para una columna angosta. En la barra horizontal hay que acotarlo — el CSS va en el Step 4.

- [ ] **Step 3: Reescribir `App.tsx`**

Cambios respecto del actual: `tab` pasa a `view` con el tipo `View`, `LeftPanel` se reemplaza por `Rail`, desaparece el `<nav className="tabs">`, y `SettingsPanel` entra como una vista más.

```tsx
import { useCallback, useEffect, useState } from 'react'
import type { CliProviderInfo, Graph, ResultRow } from '../../shared/ipc'
import { Rail, type View } from './components/Rail'
import { ResultsFeed } from './components/ResultsFeed'
import { ErrorBanner } from './components/ErrorBanner'
import { GraphView } from './components/GraphView'
import { ChatPanel } from './components/ChatPanel'
import { AgentsPanel } from './components/AgentsPanel'
import { SettingsPanel } from './components/SettingsPanel'

/** An item that started but has not finished yet: drawn with its spinner. */
export interface PendingRow {
  id: string
  label: string
}

function App(): React.JSX.Element {
  const [rows, setRows] = useState<ResultRow[]>([])
  const [inProgress, setInProgress] = useState<PendingRow | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [providers, setProviders] = useState<CliProviderInfo[]>([])
  const [providerId, setProviderId] = useState<string | null>(null)
  const [modelId, setModelId] = useState<string | null>(null)
  const [view, setView] = useState<View>('chat')
  const [refreshingCli, setRefreshingCli] = useState(false)
  const [loadingCli, setLoadingCli] = useState(true)
  const [graph, setGraph] = useState<Graph | null>(null)
  const [graphPath, setGraphPath] = useState('')
  const [building, setBuilding] = useState(false)
  const [graphProg, setGraphProg] = useState<{ done: number; total: number } | null>(null)

  const loadExisting = useCallback(async (): Promise<void> => {
    const res = await window.api.listResults()
    if (res.ok) setRows(res.data)
    else setError(res.error.message)
  }, [])

  // Start by showing what was already extracted: otherwise the screen looks
  // empty even with 48 saved results.
  useEffect(() => {
    void loadExisting()
    void window.api.loadGraph().then((res) => {
      if (!res.ok) return
      setGraph(res.data.graph)
      setGraphPath(res.data.path)
    })
    void window.api.listCliProviders().then((res) => {
      setLoadingCli(false)
      if (!res.ok) return
      setProviders(res.data)
      // Starts with the first one found: the picker reports what is there, it
      // does not ask whether to use it.
      const first = res.data[0]
      if (first !== undefined) {
        setProviderId(first.id)
        setModelId(first.models[0]?.id ?? null)
      }
    })
  }, [loadExisting])

  useEffect(() => {
    const offStart = window.api.onItemStart((e) => {
      setInProgress({ id: e.id, label: e.label })
      setProgress({ done: e.index, total: e.total })
    })

    const offDone = window.api.onItemDone((row) => {
      setInProgress(null)
      // Replaces instead of stacking: reprocessing an item does not duplicate it.
      setRows((prev) => [row, ...prev.filter((r) => r.id !== row.id)])
    })

    const offGraph = window.api.onGraphProgress(setGraphProg)

    return () => {
      offStart()
      offDone()
      offGraph()
    }
  }, [])

  const buildGraph = async (): Promise<void> => {
    if (providerId === null) {
      setError('no CLI detected to build the graph')
      return
    }
    setError(null)
    setBuilding(true)
    setGraphProg(null)

    try {
      const res = await window.api.buildGraph(providerId, modelId)
      if (res.ok) {
        setGraph(res.data.graph)
        setGraphPath(res.data.path)
        if (res.data.failedBatches > 0) {
          setError(`${res.data.failedBatches} batch(es) failed; the graph came out incomplete`)
        }
      } else {
        setError(res.error.message)
      }
    } finally {
      setBuilding(false)
      setGraphProg(null)
    }
  }

  const processBatch = async (): Promise<void> => {
    setError(null)
    setProcessing(true)
    setProgress(null)

    try {
      const res = await window.api.runExtraction({ providerId, modelId })
      if (!res.ok) setError(res.error.message)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProcessing(false)
      setInProgress(null)
      setProgress(null)
    }
  }

  const reprocessAll = async (): Promise<void> => {
    setError(null)
    setProcessing(true)

    try {
      const deleted = await window.api.resetResults()
      if (!deleted.ok) {
        setError(deleted.error.message)
        return
      }
      setRows([])
      const res = await window.api.runExtraction({ providerId, modelId })
      if (!res.ok) setError(res.error.message)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProcessing(false)
      setInProgress(null)
      setProgress(null)
    }
  }

  const refreshCli = (): void => {
    setRefreshingCli(true)
    void window.api.refreshCliProviders().then((res) => {
      if (res.ok) setProviders(res.data)
      else setError(res.error.message)
      setRefreshingCli(false)
    })
  }

  return (
    <div className="app-container">
      <Rail
        view={view}
        onView={setView}
        providerId={providerId}
        modelId={modelId}
        total={rows.length}
      />

      <main className="panel-right">
        {error !== null && <ErrorBanner message={error} />}

        {view === 'chat' ? (
          <AgentsPanel
            providers={providers}
            providerId={providerId}
            modelId={modelId}
            onError={setError}
          />
        ) : view === 'tasks' ? (
          <ChatPanel onError={setError} />
        ) : view === 'extractions' ? (
          <ResultsFeed
            rows={rows}
            inProgress={inProgress}
            processing={processing}
            progress={progress}
            onProcess={processBatch}
            onReprocess={reprocessAll}
          />
        ) : view === 'settings' ? (
          <SettingsPanel
            providers={providers}
            providerId={providerId}
            modelId={modelId}
            refreshing={refreshingCli}
            loading={loadingCli}
            onCliChange={(p, m) => {
              setProviderId(p)
              setModelId(m)
            }}
            onRefreshCli={refreshCli}
            onError={setError}
          />
        ) : (
          <GraphView
            graph={graph}
            path={graphPath}
            building={building}
            progress={graphProg}
            onBuild={buildGraph}
            onOpenFolder={() => void window.api.revealGraph()}
          />
        )}
      </main>
    </div>
  )
}

export default App
```

- [ ] **Step 4: Borrar `LeftPanel.tsx` y agregar los estilos del rail**

```bash
git rm src/renderer/src/components/LeftPanel.tsx
```

Agregar al final de `main.css`:

```css
/* ── rail ────────────────────────────────────────────────────────────────
   Identity and navigation. Chat carries the weight; the rest is a lighter
   group below it — reachable, but clearly not the point of the app.
   ---------------------------------------------------------------------- */

.rail-nav {
  display: flex;
  flex-direction: column;
  gap: 18px;
  margin-top: 1.75rem;
}

.rail-item {
  display: block;
  width: 100%;
  padding: 6px 0;
  text-align: left;
  background: none;
  border: none;
  border-left: 2px solid transparent;
  padding-left: 12px;
  font-family: var(--font-sans);
  font-size: 0.86rem;
  color: var(--muted);
  cursor: pointer;
  transition: color 140ms ease, border-color 140ms ease;
}

.rail-item:hover { color: var(--ink); }

.rail-item-on {
  color: var(--brass);
  border-left-color: var(--brass);
}

/* The conversation is the app: serif and bigger, like the name of a thing
   rather than the label of a menu entry. */
.rail-item-main {
  font-family: var(--font-serif);
  font-size: 1.25rem;
}

.rail-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

.rail-group .rail-item {
  font-size: 0.78rem;
  opacity: 0.85;
}

.rail-foot {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.rail-status {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 8px 0 8px 12px;
  border-top: 1px solid var(--line);
  border-left: 2px solid transparent;
}

.rail-status-line {
  font-family: var(--font-mono);
  font-size: 0.74rem;
  color: var(--ink);
}

.rail-status-sub {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  color: var(--muted);
}

.rail-status-gear {
  margin-top: 3px;
  font-size: 0.62rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
}

.rail-status:hover .rail-status-gear { color: var(--brass); }

/* ── worker controls, now inside the extractions view ────────────────── */

.feed-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding-bottom: 14px;
  margin-bottom: 10px;
  border-bottom: 1px solid var(--line);
}

/* .btn-brass and .btn-ghost are 100% wide by default — that was for a narrow
   column. In a horizontal bar they have to be their own size. */
.feed-bar .btn-brass,
.feed-bar .btn-ghost {
  width: auto;
  margin-top: 0;
}

.feed-bar .progress-block {
  flex: 1 1 220px;
  min-width: 0;
  margin-top: 0;
}
```

Y borrar el CSS que se quedó sin dueño: el bloque `.tabs` (lo usaba la barra de pestañas) y `.brand-description` (`LeftPanel` renderizaba un párrafo de descripción que el rail no tiene). Confirmar con una búsqueda antes de borrar cada uno:

```
Grep: brand-description|className="tabs"   en  src/renderer  y  src/main/devtools
```

Esperado: cero resultados fuera del propio CSS.

- [ ] **Step 5: Actualizar `ui-selftest.ts` al rail nuevo**

En `src/main/devtools/ui-selftest.ts`:

1. `const active = document.querySelector('.tabs .pick-on')` → `document.querySelector('.rail-item-on')`
2. El assert `check('hay una pestaña "agentes"', ui.tabs.includes('agentes'), true)` → leer `.rail-item` y verificar que incluya `'Chat'`.
3. Restaurar el assert de conexiones que la Tarea 2 dejó comentado, ahora navegando por el rail:

```js
`(() => { const b = document.querySelector('.rail-item[data-view="settings"]'); if (b) b.click(); return true })()`
```

- [ ] **Step 6: Verificar**

```bash
npm run typecheck
npm run ui:selftest
```

Esperado: `typecheck` sin errores; `ui:selftest` con todos los asserts en verde. Si un assert falla, es este cambio — no un problema previo.

- [ ] **Step 7: Verificar a ojo**

```bash
npm run dev
```

Esperado: arranca en Chat. El rail muestra Chat arriba y Extractions / Graph / Tasks abajo, más chicos. El pie muestra el CLI y el modelo, y clickearlo abre Settings. Las conexiones se ven ahí, no dentro del agente de trabajo.

- [ ] **Step 8: Commit**

```bash
git add -A src/renderer src/main/devtools/ui-selftest.ts
git commit -m "feat(ui): la conversación al frente, con un rail en vez de pestañas"
```

---

### Task 4: El renderer en inglés

**Files:**
- Modify: todos los `.tsx` bajo `src/renderer/src/components/` que la Tarea 3 no dejó ya en inglés — `ResultsFeed.tsx`, `GraphView.tsx`, `GraphCanvas.tsx`, `ChatPanel.tsx`, `AgentsPanel.tsx`, `JobChat.tsx`, `ConnectionsPanel.tsx`, `ErrorBanner.tsx`
- Modify: `src/renderer/index.html` (el `<title>`)

**Interfaces:**
- Consumes: nada. Es una pasada de copy sobre componentes ya montados.
- Produces: nada nuevo. Ningún nombre de clase CSS cambia — las clases en español (`.conexion-*`, `.agente-*`, `.pregunta-*`, `.reglas-*`, `.job-*`) **se dejan como están**. Renombrarlas es un diff enorme y sin valor para el usuario, y es exactamente donde se cuela un typo que rompe un estilo en silencio.

- [ ] **Step 1: Traducir el copy visible, componente por componente**

Regla de la pasada: cambia **texto entre etiquetas JSX, `placeholder`, `title`, `aria-label` y `alt`**. No cambia: nombres de clase, `data-*`, claves de objeto, ids, ni ningún valor de la tabla de contratos congelados.

Ejemplos concretos de lo que sí cambia:

| Archivo | Antes | Después |
|---|---|---|
| `AgentsPanel.tsx` | `buscando agentes…` | `looking for agents…` |
| `AgentsPanel.tsx` | `no hay agentes registrados` | `no agents registered` |
| `AgentsPanel.tsx` | `El agente te preguntó` | `The agent asked you` |
| `AgentsPanel.tsx` | `tu respuesta queda escrita en las reglas — no vuelve a preguntar` | `your answer is written into the rules — it will not ask again` |
| `AgentsPanel.tsx` | `Tus reglas` | `Your rules` |
| `AgentsPanel.tsx` | `escribí tu respuesta…` | `type your answer…` |
| `ConnectionsPanel.tsx` | `cargando conexiones…` | `loading connections…` |
| `ConnectionsPanel.tsx` | `pegá el token acá` | `paste the token here` |
| `ConnectionsPanel.tsx` | `se abre una ventana · entrás vos · el resto lo hace Albus` | `a window opens · you sign in · Albus does the rest` |
| `index.html` | el `<title>` actual | `Albus` |

- [ ] **Step 2: Barrer lo que quedó**

```bash
git diff --stat
```

Y buscar acentos sobrevivientes en el renderer:

```
Grep: [áéíóúñ¿¡]  en  src/renderer/src  (glob *.tsx)
```

Esperado: solo comentarios en español, que se dejan. Si aparece un string dentro de JSX, quedó sin traducir.

- [ ] **Step 3: Verificar**

```bash
npm run typecheck
npm run ui:selftest
```

Si `ui:selftest` falla acá, es porque un assert compara texto en español que acabás de traducir. Actualizá el assert, no revertir el copy.

- [ ] **Step 4: Commit**

```bash
git add src/renderer
git commit -m "refactor(ui): el copy del renderer pasa a inglés"
```

---

### Task 5: Los strings del main que el usuario lee

**Files:**
- Modify: `src/main/connections/registry.ts` (los `name`, `purpose`, `detail` y los `step` de `onStep`)
- Modify: `src/main/agents/registry.ts` (los `name`, `description`, `reason` de cada `AgentInfo`)
- Modify: los mensajes de error que llegan al renderer vía el sobre IPC, en `src/main/ipc/*.ts` y en los `throw new Error(...)` que esos handlers propagan

**Interfaces:**
- Consumes: nada.
- Produces: nada nuevo. Solo cambia el contenido de campos string que ya viajan por el IPC.

- [ ] **Step 1: Enumerar la superficie real, no adivinar**

Solo cuatro caminos llevan texto del main a la pantalla. Traducir esos y nada más:

1. `IpcResult.error.message` — todo lo que sale por `registerHandler` cuando algo falla
2. `ConnectionInfo.name` · `.purpose` · `.detail` — `src/main/connections/registry.ts`
3. `ConnectionStepRow.step` · `.detail` — los `onStep?.({ step: '…' })` del mismo archivo
4. `AgentInfo.name` · `.description` · `.reason` — `src/main/agents/registry.ts`

**Lo que NO se toca:** los `console.log` de los scripts de `scripts/` y `src/main/devtools/` (son herramientas de desarrollo, no UI), los comentarios, y todo `id` / `group` de `connections/registry.ts` — esas son las claves de `connections.json`.

- [ ] **Step 2: Traducir `connections/registry.ts`**

Ejemplos exactos de este archivo:

| Línea aprox. | Antes | Después |
|---|---|---|
| 82 | `'Leer y escribir en las páginas y bases que le compartas.'` | `'Read and write the pages and databases you share with it.'` |
| 127 | `'Mandar correos desde tu cuenta y guardar archivos en tu Drive.'` | `'Send email from your account and save files to your Drive.'` |
| 133 | `'Un click y listo, no hay que buscar nada.'` | `'One click and done — nothing to look up.'` |
| 143 | `'Conectado pero sin permiso de correo. Volvé a conectar.'` | `'Connected, but without mail permission. Connect again.'` |
| 146 | `'No pude verificar los permisos.'` | `'Could not verify the permissions.'` |
| 150 | `'abrir el consentimiento de Google'` | `'open the Google consent screen'` |
| 185 | `'los SSO de Google se resuelven solos'` / `'esta es la que desbloquea el resto'` | `'Google SSO resolves on its own'` / `'this is the one that unlocks the rest'` |
| 193 | `'entrá con tu cuenta en la ventana que se abrió'` | `'sign in with your account in the window that opened'` |
| 196 | `'guardar la sesión'` / `'la cookie quedó en el perfil'` | `'save the session'` / `'the cookie is in the profile'` |
| 208 | `'Navegar el sitio con tu sesión, sin volver a entrar cada vez.'` | `'Browse the site with your session, without signing in every time.'` |
| 216 | `'Entrás una vez y la sesión queda guardada dentro de Albus.'` | `'You sign in once and the session stays inside Albus.'` |
| 223 | `'entrá a mano: el login no se automatiza, su antifraude lo marca'` | `'sign in by hand: the login is not automated, their antifraud flags it'` |
| 317 | `` `la base responde: ${urls.size} postulación(es) registradas` `` | `` `the database responds: ${urls.size} application(s) logged` `` |

Dejar intactos los `id`, los `group`, y `name: 'Notion'` / `'Google'` / `'LinkedIn'`, que ya son nombres propios.

- [ ] **Step 3: Traducir los mensajes de error del IPC**

Barrer los handlers:

```
Grep: message: '|throw new Error\('   en  src/main/ipc  (output_mode: content)
```

Traducir cada string que pueda terminar en `error.message`. El renderer los pinta crudos en `ErrorBanner`.

- [ ] **Step 4: Traducir `agents/registry.ts`**

Los `name`, `description` y `reason` de cada agente registrado. El `id` (`'job-search'`) **no se toca**: es la clave del mapa `PANELS` en `AgentsPanel.tsx`, del directorio `agents/<id>/` y de `<id>.agente.json`.

- [ ] **Step 5: Revisar el diff contra la tabla de contratos congelados**

```bash
git diff
```

Leer el diff completo con la tabla de "Contratos congelados" al lado. Si aparece cambiado **uno solo** de esos valores, revertir esa línea. Este paso no se saltea: es el único control que existe contra un fallo que no tira error.

- [ ] **Step 6: Verificar**

```bash
npm run typecheck
npm run jobs:check
npm run ui:selftest
```

`jobs:check` corre el dominio y el contrato de IPC sin red ni Electron. Esperado: los tres en verde.

- [ ] **Step 7: Commit**

```bash
git add src/main
git commit -m "refactor(main): los mensajes que el usuario lee pasan a inglés"
```

---

## Cierre

Al terminar la Tarea 5, `docs/superpowers/specs/2026-08-12-albus-shell-redesign-design.md` pasa de "aprobado, sin implementar" a "implementado". Actualizar esa línea y commitear con el resto.

El **proyecto B** (motor de memoria: cascada de reconocimiento, decisiones que se vuelven reglas, flujos con modos `dry-run`/`review`/`auto`) arranca con su propio spec. La sección "Fuera de alcance" del spec de A es su punto de partida.
