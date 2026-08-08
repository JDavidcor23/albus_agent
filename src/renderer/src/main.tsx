import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/instrument-serif'
import '@fontsource-variable/geist-mono'
// La humanista del cuerpo. Antes TODO era monoespaciado y la app se leía como
// una terminal: correcto para un log, hostil para una pantalla que alguien usa
// todos los días.
import '@fontsource-variable/inter-tight'
import './assets/main.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

