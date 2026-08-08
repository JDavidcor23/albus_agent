import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

// Mismo motivo que en supabase/client.ts: electron-vite solo inyecta al main las
// variables con prefijo MAIN_VITE_, así que las cargamos a mano para poder usar
// nombres normales y que funcione igual empaquetado.
loadDotenv()

const TokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number()
})

let cached: { token: string; expiresAt: number } | null = null

/**
 * Igual que en Notion: por defecto sale del `.env` para que este archivo no
 * importe electron, y la app lo pisa con el que el usuario conectó por el
 * botón, guardado cifrado. Conectar de nuevo tiene que invalidar el access
 * token cacheado, para eso `forgetCachedToken`.
 */
let refreshTokenResolver: () => string | null = () => process.env.GOOGLE_REFRESH_TOKEN ?? null

export function setGoogleRefreshTokenResolver(fn: () => string | null): void {
  refreshTokenResolver = fn
  cached = null
}

export function forgetCachedToken(): void {
  cached = null
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    // Ruidoso a propósito: sin credenciales el archivado no puede funcionar y es
    // mejor enterarse acá que ver items procesados sin imagen y no saber por qué.
    throw new Error(`Falta la variable de entorno ${name}`)
  }
  return value
}

/** ¿Está Drive configurado? Permite arrancar la app sin credenciales de Google. */
export function isDriveConfigured(): boolean {
  const refresh = refreshTokenResolver()
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && refresh
  )
}

/**
 * Access token de Google, cacheado en memoria. Duran una hora; renovamos un
 * minuto antes para no perder una request contra el borde de la expiración.
 *
 * El refresh token no caduca porque la app está "En producción" en el proyecto
 * de Google Cloud. En modo prueba caducaría a los 7 días.
 */
export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token

  const refresh = refreshTokenResolver()
  if (refresh === null) {
    throw new Error(
      'Google no está conectado. Andá a la pestaña de agentes → Conexiones → Conectar Google.'
    )
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: requireEnv('GOOGLE_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
      refresh_token: refresh,
      grant_type: 'refresh_token'
    })
  })

  const json: unknown = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Google rechazó el refresh token: ${JSON.stringify(json)}`)

  const parsed = TokenSchema.safeParse(json)
  if (!parsed.success) throw new Error(`Token con forma inesperada: ${parsed.error.message}`)

  cached = {
    token: parsed.data.access_token,
    expiresAt: Date.now() + parsed.data.expires_in * 1000
  }
  return cached.token
}

/** Llamada a la API de Drive. Todo lo que vuelve es input externo: validalo. */
export async function driveFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = await getAccessToken()
  const res = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body !== undefined && !(init.headers as Record<string, string>)?.['Content-Type']
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(init.headers ?? {})
    }
  })

  const json: unknown = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Drive ${res.status}: ${JSON.stringify(json)}`)
  return json
}

export async function driveUpload(body: BodyInit, contentType: string): Promise<unknown> {
  const token = await getAccessToken()
  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,parents',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body
    }
  )

  const json: unknown = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Drive upload ${res.status}: ${JSON.stringify(json)}`)
  return json
}
