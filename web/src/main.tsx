import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { applyScheme, watchSystemScheme } from './lib/colorScheme'
import { App } from './App'

// index.html already put the theme on <html> before the first paint; this keeps it in step with the OS while the
// scheme is System.
applyScheme()
watchSystemScheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
