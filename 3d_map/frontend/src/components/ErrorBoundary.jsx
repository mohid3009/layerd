import React from 'react'

// catches render crashes anywhere in the tree and shows the error instead of
// a black screen — makes failures diagnosable from the page itself
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: '#f5f5f7', background: '#000', minHeight: '100vh', fontFamily: 'monospace' }}>
          <h2 style={{ color: '#fca5a5' }}>something crashed</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#a1a1a6', fontSize: 12 }}>
            {String(this.state.error?.stack || this.state.error)}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}
