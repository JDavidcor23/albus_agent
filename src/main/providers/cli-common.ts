import { execFile } from 'node:child_process'

/**
 * Los CLI instalados por npm en Windows son shims `.cmd`: execFile necesita la
 * ruta resuelta, no el nombre pelado. Se cachea solo el acierto — si el CLI
 * aparece después, la próxima llamada lo vuelve a buscar.
 */
export function resolveBinary(
  name: string,
  cache: { value: string | null | undefined }
): Promise<string | null> {
  if (cache.value !== undefined) return Promise.resolve(cache.value)

  return new Promise((resolve) => {
    execFile('where', [name], { encoding: 'utf8' }, (err, stdout) => {
      if (err || !stdout) {
        resolve(null)
        return
      }

      const primera =
        stdout
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.length > 0) ?? null

      if (primera !== null) cache.value = primera
      resolve(primera)
    })
  })
}

export const TIMEOUT_MS = 120_000

/**
 * Envoltorio de un spawn con timeout duro y una sola resolución.
 *
 * `timeoutMs` y `onLinea` existen por un caso concreto: generar un CV a medida
 * corre un agente que compila LaTeX, lee el PDF y lo verifica contra veinte
 * puntos. Eso tarda minutos, no segundos, y el usuario necesita ver que algo
 * pasa mientras tanto o va a pensar que se colgó.
 */
export function collect(
  child: import('node:child_process').ChildProcess,
  etiqueta: string,
  prompt: string | null,
  opciones: { timeoutMs?: number; onLinea?: (linea: string) => void } = {}
): Promise<string> {
  const limite = opciones.timeoutMs ?? TIMEOUT_MS

  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }

    let stdout = ''
    let stderr = ''

    let pendiente = ''

    child.stdout?.on('data', (c: Buffer) => {
      const texto = c.toString('utf8')
      stdout += texto

      if (opciones.onLinea === undefined) return
      // Se emiten líneas completas: un chunk parte una línea al medio y la UI
      // mostraría medio renglón.
      pendiente += texto
      const lineas = pendiente.split('\n')
      pendiente = lineas.pop() ?? ''
      for (const l of lineas) {
        const limpia = l.trim()
        if (limpia !== '') opciones.onLinea(limpia)
      }
    })
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
    })

    const timer = setTimeout(() => {
      child.kill()
      settle(() => reject(new Error(`${etiqueta} excedió ${limite / 1000}s`)))
    }, limite)

    child.on('error', (err) => {
      clearTimeout(timer)
      settle(() => reject(err))
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      const texto = stdout.trim()
      settle(() => {
        if (code === 0 && texto.length > 0) resolve(texto)
        else reject(new Error(`${etiqueta} falló (exit ${code}): ${stderr.slice(0, 300)}`))
      })
    })

    if (prompt !== null && child.stdin) {
      // Un EPIPE sin handler tumba el main; 'error'/'close' ya resuelven.
      child.stdin.on('error', () => {})
      child.stdin.end(prompt, 'utf8')
    }
  })
}
