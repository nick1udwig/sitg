import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class AppErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('Render error', error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <section className="card">
          <h2>Something went wrong</h2>
          <p className="error">{this.state.message || 'Unexpected render failure.'}</p>
          <button onClick={() => window.location.reload()}>Reload</button>
        </section>
      );
    }

    return this.props.children;
  }
}
