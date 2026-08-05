import { config as loadDotenv } from 'dotenv'
import WebSocket from 'ws'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// electron-vite solo inyecta al main las variables con prefijo MAIN_VITE_, así que
// un SUPABASE_URL pelado en .env nunca llegaría a process.env. Lo cargamos a mano
// para poder usar los nombres normales y que funcione igual empaquetado.
loadDotenv()

// No usamos realtime, pero supabase-js instancia su cliente igual y busca un
// WebSocket global. Electron 33 trae Node 20, que no lo tiene, y revienta con
// "native WebSocket not found" antes de la primera query — la app entera queda
// muerta. Con el Node 22 del sistema no pasa, por eso los scripts sí andaban.
// Se rellena el global en vez de pasar `realtime.transport` porque el tipo de
// `ws` no encaja con el que declara supabase.
if (typeof globalThis.WebSocket === 'undefined') {
  ;(globalThis as { WebSocket?: unknown }).WebSocket = WebSocket
}

let clientInstance: SupabaseClient | null = null

export function getSupabaseClient(): SupabaseClient {
  if (clientInstance) {
    return clientInstance
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Faltan variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY')
  }

  clientInstance = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  })

  return clientInstance
}
