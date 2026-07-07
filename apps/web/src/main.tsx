import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { shouldForceMobileShell } from './shell'

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Paotuan UI crashed', error, info.componentStack)
  }

  render() {
    if (!this.state.error) {
      return this.props.children
    }

    return (
      <main className="app-error-fallback" role="alert">
        <section>
          <h1>页面加载异常</h1>
          <p>当前页面数据不完整或临时加载失败，已阻止白屏。返回上级页面或刷新后可继续使用。</p>
          <div>
            <button type="button" onClick={() => window.location.reload()}>
              刷新页面
            </button>
            <button
              type="button"
              onClick={() => {
                localStorage.removeItem('paotuan.activeRoom')
                window.location.reload()
              }}
            >
              回到大厅
            </button>
          </div>
          <small>{this.state.error.message}</small>
        </section>
      </main>
    )
  }
}

const isAndroidShell = shouldForceMobileShell({
  hostname: window.location.hostname,
  userAgent: window.navigator.userAgent,
})

if (isAndroidShell) {
  document.documentElement.classList.add('force-mobile')
  document.body.classList.add('force-mobile')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)
