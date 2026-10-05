const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * Makes THIS process stop reading the console, so a child with
 * `stdio: 'inherit'` gets every keystroke. Call it inside Ink's
 * `suspendTerminal` callback, right before spawning the child.
 *
 * Why not just `process.stdin.pause()`: Node only issues the low-level
 * `readStop` for stdin from its own 'pause' listener, and `pause()` only
 * emits 'pause' when the stream was FLOWING. Ink reads stdin through a
 * 'readable' listener (non-flowing), so a bare `pause()` is a no-op and the
 * console read stays pending — on Windows that read competes with the child
 * for the user's input. `resume()` first makes the stream flowing (anything
 * already buffered is dropped: nobody listens to 'data'), then `pause()`
 * emits 'pause' and Node stops the read on the next tick.
 *
 * The first `nextTurn` lets Node apply Ink's `removeListener('readable')`
 * (it updates that bookkeeping on a later tick); until then `resume()`
 * would not switch the stream to flowing. Ink's resume re-attaches its
 * 'readable' listener, which starts reading again by itself.
 */
export async function stopReadingStdin(): Promise<void> {
  await nextTurn()
  process.stdin.resume()
  process.stdin.pause()
  await nextTurn()
}
