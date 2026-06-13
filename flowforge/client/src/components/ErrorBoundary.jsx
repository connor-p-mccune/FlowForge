import { Component } from 'react'

// Catches render/lifecycle errors anywhere below it so a single broken
// component shows a recoverable fallback instead of a blank white screen.
// (React only routes render-phase errors here — async/event-handler errors are
// surfaced via toasts instead.)
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Uncaught error in component tree:', error, info)
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <div className="error-boundary__card">
            <h1 className="error-boundary__title">Something went wrong</h1>
            <p className="error-boundary__message">
              FlowForge hit an unexpected error and couldn’t render this view.
              Reloading usually clears it.
            </p>
            {this.state.error?.message && (
              <pre className="error-boundary__detail">{this.state.error.message}</pre>
            )}
            <button className="error-boundary__btn" onClick={this.handleReload}>
              Reload app
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
