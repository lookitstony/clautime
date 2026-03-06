import './index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { FloatingWidget } from './features/live/FloatingWidget'

const isWidget = window.location.hash.startsWith('#widget/')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isWidget ? <FloatingWidget /> : <App />}
  </StrictMode>
)
