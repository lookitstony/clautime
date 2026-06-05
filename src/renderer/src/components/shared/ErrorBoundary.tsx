import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  render(): ReactNode {
    if (!this.state.hasError || !this.state.error) {
      return this.props.children
    }

    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md space-y-4 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10">
            <span className="text-2xl text-red-400">!</span>
          </div>
          <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">
            Something went wrong
          </h2>
          <p className="text-[13px] text-[var(--text-muted)]">{this.state.error.message}</p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, error: null })}
            className="rounded-md bg-[var(--accent)] px-4 py-2 text-[13px] font-medium text-white hover:brightness-[1.15]"
          >
            Try Again
          </button>
        </div>
      </div>
    )
  }
}
