import { StrictMode, type JSX } from 'react'
import { createRoot } from 'react-dom/client'

export function App(): JSX.Element {
  return (
    <main style={{ padding: '2rem' }}>
      <h1>Reference Image Studio</h1>
    </main>
  )
}

const container = document.getElementById('root')

if (container === null) {
  throw new Error('Renderer bootstrap failed: #root is missing from index.html')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
