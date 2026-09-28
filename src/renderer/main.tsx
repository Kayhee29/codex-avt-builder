/**
 * The renderer entry point (plan Task 5.1).
 *
 * Mounting is separated from `app.tsx` so that importing `App` in a test does
 * not try to find `#root` and render the whole application as a side effect of
 * the import.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app.tsx'

const container = document.getElementById('root')

if (container === null) {
  throw new Error('Renderer bootstrap failed: #root is missing from index.html')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
