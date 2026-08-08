import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

loadDotenv()

/**
 * Cliente de Notion con token de integración interna.
 *
 * NO va por el MCP de Claude Code a propósito. El MCP existe para que YO lea
 * la base durante una conversación; Albus tiene que poder escribir a las 7 de
 * la mañana con nadie mirando, y un MCP autenticado a mano contra claude.ai no
 * está disponible ahí. Un token en `.env` es el mismo patrón que Supabase y
 * Drive: secreto en el entorno, adaptador en el main, y nada de esto cruza al
 * renderer.
 *
 * Setup, una vez:
 *   1. notion.so/my-integrations → New integration → copiar el token
 *   2. En la página "Registro de aplicaciones": ⋯ → Connections → tu integración
 *   3. NOTION_TOKEN=ntn_... en el .env
 */

export const NOTION_VERSION = '2022-06-28'

/**
 * La base del usuario. Último recurso, no la fuente.
 *
 * Un id hardcodeado solo funciona en UNA cuenta: la pregunta *"¿y cómo sabe
 * qué proyecto va a escoger?"* era justa. Hoy la fuente es el archivo de
 * reglas del agente —`agentes/job-search.md`, donde el usuario pega el link de
 * su base—, y esto queda como red para que nada explote si todavía no lo
 * escribió.
 */
export const DEFAULT_DATABASE_ID = '81e09fb24cbb4a76bb7015cec17003e2'

/**
 * De dónde sale el id de la base. Mismo patrón que el token: por defecto el
 * entorno, y la app lo pisa con lo que diga el `.md` de reglas. Así este
 * archivo sigue sin importar electron y los chequeos lo pueden correr con tsx.
 */
let databaseIdResolver: () => string | null = () => process.env.NOTION_JOBS_DATABASE_ID ?? null

export function setNotionDatabaseIdResolver(fn: () => string | null): void {
  databaseIdResolver = fn
}

export function notionDatabaseId(): string {
  const chosen = databaseIdResolver()
  return chosen !== null && chosen.trim() !== '' ? chosen.trim() : DEFAULT_DATABASE_ID
}

/**
 * De dónde sale el token.
 *
 * Por defecto, del entorno — así este archivo no importa electron y los
 * chequeos pueden correrlo con `npx tsx`. En la app, `connections/bootstrap`
 * lo reemplaza por uno que además mira lo que el usuario pegó en la UI, que
 * está cifrado con safeStorage y gana sobre el `.env`.
 */
let tokenResolver: () => string | null = () => process.env.NOTION_TOKEN ?? null

export function setNotionTokenResolver(fn: () => string | null): void {
  tokenResolver = fn
}

export function isNotionConfigured(): boolean {
  const t = tokenResolver()
  return t !== null && t.trim() !== ''
}

function requireToken(): string {
  const token = tokenResolver()
  if (!token) {
    // Ruidoso: sin token no hay espejo en Notion, y descubrirlo por una fila
    // que nunca apareció es peor que fallar acá.
    throw new Error(
      'Falta NOTION_TOKEN en .env. Creá una integración interna en notion.so/my-integrations, ' +
        'compartí con ella la página "Registro de aplicaciones" y pegá el token.'
    )
  }
  return token
}

/** Todo lo que vuelve de Notion es input externo: lo valida quien lo llama. */
export async function notionFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${requireToken()}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init.headers ?? {})
    }
  })

  const json: unknown = await res.json().catch(() => ({}))

  if (!res.ok) {
    const detail = z.object({ message: z.string() }).safeParse(json)
    throw new Error(
      `Notion ${res.status}: ${detail.success ? detail.data.message : JSON.stringify(json)}`
    )
  }

  return json
}
