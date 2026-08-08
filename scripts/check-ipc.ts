/**
 * El punto ciego del compilador.
 *
 * `npm run typecheck` no puede ver a través de `ipcRenderer.invoke`. El renderer
 * manda un objeto, el main lo valida con zod, y entre los dos no hay ningún tipo
 * que TypeScript pueda cruzar: el canal es un string y el payload viaja como
 * `unknown`. Si el preload manda `{ texto }` y el schema espera `{ text }`,
 * compila perfecto y revienta en runtime, en la mano del usuario.
 *
 * Este script lee los dos lados con la API del compilador —no con regex, que es
 * el atajo que falla en silencio— y compara:
 *
 *   src/preload/index.ts   ipcRenderer.invoke(IpcChannels.X, { a, b })
 *   src/main/ipc/*.ts      registerHandler(IpcChannels.X, ...) + z.object({...})
 *
 * Falla si el schema exige una clave que el preload no manda. Avisa (sin fallar)
 * si el preload manda una clave que el schema ignora: eso es código muerto, no
 * una rotura.
 *
 * No necesita Electron, ni red, ni credenciales. Corre con `npx tsx`.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const IPC_DIR = join(process.cwd(), 'src', 'main', 'ipc')
const PRELOAD = join(process.cwd(), 'src', 'preload', 'index.ts')

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

/** `IpcChannels.JOBS_HUNT` → `JOBS_HUNT`. Cualquier otra cosa, null. */
function channelOf(node: ts.Node | undefined): string | null {
  if (node && ts.isPropertyAccessExpression(node) && node.expression.getText() === 'IpcChannels') {
    return node.name.text
  }
  return null
}

function propertyNames(obj: ts.ObjectLiteralExpression): Set<string> {
  const keys = new Set<string>()
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) continue
    if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) keys.add(p.name.text)
  }
  return keys
}

// ── lado renderer: qué claves manda el preload, por canal ────────────────────

type Sent = { keys: Set<string>; resolved: boolean }

function readPreload(): Map<string, Sent> {
  const src = parse(PRELOAD)
  const out = new Map<string, Sent>()

  /** Un `req: { text: string; jobs: X[] }` en la firma de la función que envuelve. */
  const typeLiteralKeys = (name: string, from: ts.Node): Set<string> | null => {
    let found: Set<string> | null = null
    let scope: ts.Node | undefined = from
    while (scope && !found) {
      if (ts.isArrowFunction(scope) || ts.isFunctionExpression(scope)) {
        for (const param of scope.parameters) {
          if (!ts.isIdentifier(param.name) || param.name.text !== name) continue
          const t = param.type
          if (t && ts.isTypeLiteralNode(t)) {
            const keys = new Set<string>()
            for (const m of t.members) {
              if (ts.isPropertySignature(m) && m.name && ts.isIdentifier(m.name)) keys.add(m.name.text)
            }
            found = keys
          }
        }
      }
      scope = scope.parent
    }
    return found
  }

  walk(src, (node) => {
    if (!ts.isCallExpression(node)) return
    const callee = node.expression
    if (!ts.isPropertyAccessExpression(callee)) return
    if (callee.name.text !== 'invoke' || callee.expression.getText() !== 'ipcRenderer') return

    const channel = channelOf(node.arguments[0])
    if (!channel) return

    const payload = node.arguments[1]
    if (payload === undefined) {
      out.set(channel, { keys: new Set(), resolved: true })
      return
    }
    if (ts.isObjectLiteralExpression(payload)) {
      out.set(channel, { keys: propertyNames(payload), resolved: true })
      return
    }
    if (ts.isIdentifier(payload)) {
      const keys = typeLiteralKeys(payload.text, node)
      out.set(channel, { keys: keys ?? new Set(), resolved: keys !== null })
      return
    }
    // `opts ?? {}` y compañía: no lo puedo resolver estáticamente.
    out.set(channel, { keys: new Set(), resolved: false })
  })

  return out
}

// ── lado main: qué claves EXIGE el schema, por canal ─────────────────────────

const OPTIONAL = new Set(['optional', 'nullish', 'default', 'catch'])

/** Recorre `z.string().min(1).optional()` buscando un eslabón que la haga opcional. */
function isOptional(expr: ts.Expression): boolean {
  let cur: ts.Expression = expr
  while (ts.isCallExpression(cur)) {
    const callee = cur.expression
    if (ts.isPropertyAccessExpression(callee)) {
      if (OPTIONAL.has(callee.name.text)) return true
      cur = callee.expression
      continue
    }
    break
  }
  return false
}

type Schema = { required: Set<string>; all: Set<string> }

function schemaOf(obj: ts.ObjectLiteralExpression): Schema {
  const required = new Set<string>()
  const all = new Set<string>()
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue
    if (!p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) continue
    all.add(p.name.text)
    if (!isOptional(p.initializer)) required.add(p.name.text)
  }
  return { required, all }
}

/** `z.object({...})` — devuelve el objeto literal de adentro. */
function zObjectArg(node: ts.Node): ts.ObjectLiteralExpression | null {
  if (!ts.isCallExpression(node)) return null
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee)) return null
  if (callee.name.text !== 'object' || callee.expression.getText() !== 'z') return null
  const arg = node.arguments[0]
  return arg && ts.isObjectLiteralExpression(arg) ? arg : null
}

function readHandlers(): Map<string, Schema | null> {
  const out = new Map<string, Schema | null>()

  for (const file of readdirSync(IPC_DIR).filter((f) => f.endsWith('.ipc.ts'))) {
    const src = parse(join(IPC_DIR, file))

    // Schemas declarados a nivel de módulo: `const HuntSchema = z.object({...})`
    const byName = new Map<string, Schema>()
    walk(src, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return
      const obj = zObjectArg(node.initializer)
      if (obj) byName.set(node.name.text, schemaOf(obj))
    })

    walk(src, (node) => {
      if (!ts.isCallExpression(node)) return
      if (node.expression.getText() !== 'registerHandler') return
      const channel = channelOf(node.arguments[0])
      if (!channel) return

      const handler = node.arguments[1]
      if (!handler) return

      // Dentro del handler, el primer `.parse(payload)` manda.
      let schema: Schema | null = null
      walk(handler, (inner) => {
        if (schema || !ts.isCallExpression(inner)) return
        const callee = inner.expression
        if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'parse') return
        const target = callee.expression
        const obj = zObjectArg(target)
        if (obj) {
          schema = schemaOf(obj)
        } else if (ts.isIdentifier(target) && byName.has(target.text)) {
          schema = byName.get(target.text) ?? null
        }
      })
      out.set(channel, schema)
    })
  }

  return out
}

// ── comparación ──────────────────────────────────────────────────────────────

const sent = readPreload()
const expected = readHandlers()

let failures = 0
let warnings = 0
let checked = 0
const unresolved: string[] = []

console.log('\n── IPC · lo que manda el preload vs. lo que exige el schema\n')

for (const [channel, schema] of [...expected].sort()) {
  if (!schema) continue // handler sin payload: nada que cruzar
  const from = sent.get(channel)

  if (!from) {
    console.log(`  FALLA ${channel}: el main lo registra y el preload no lo llama`)
    failures++
    continue
  }
  if (!from.resolved) {
    unresolved.push(channel)
    continue
  }

  checked++
  const missing = [...schema.required].filter((k) => !from.keys.has(k))
  const extra = [...from.keys].filter((k) => !schema.all.has(k))

  if (missing.length > 0) {
    console.log(`  FALLA ${channel}: el schema exige [${missing.join(', ')}] y el preload no lo manda`)
    console.log(`        preload manda: [${[...from.keys].join(', ')}]`)
    failures++
  } else {
    console.log(`  ok    ${channel}  {${[...schema.required].join(', ')}}`)
  }

  if (extra.length > 0) {
    console.log(`  aviso ${channel}: el preload manda [${extra.join(', ')}] y el schema lo ignora`)
    warnings++
  }
}

if (unresolved.length > 0) {
  console.log(`\n  sin resolver estáticamente (revisalos a mano): ${unresolved.join(', ')}`)
}

console.log('\n' + '='.repeat(60))
console.log(
  failures === 0
    ? `IPC   ${checked}/${checked} ✓${warnings > 0 ? `   (${warnings} aviso/s)` : ''}`
    : `IPC   ${failures} FALLA/S de ${checked + failures}`
)
console.log('='.repeat(60) + '\n')

process.exit(failures === 0 ? 0 : 1)
