import React from 'react';
import { Card } from './Card.jsx';
import { Button } from './Button.jsx';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught rendering error:', error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ maxWidth: '560px', margin: 'var(--space-12) auto', padding: '0 var(--space-4)' }}>
          <Card>
            <h2 style={{ fontSize: 'var(--font-size-xl)', marginBottom: 'var(--space-2)' }}>
              Something went wrong
            </h2>
            <p style={{ marginBottom: 'var(--space-4)', color: 'var(--color-text-secondary)' }}>
              An unexpected error occurred while displaying this page. Your data has not been affected.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
              <Button onClick={this.handleReload} variant="primary">
                Reload page
              </Button>
              <Button onClick={() => window.location.href = '/properties'} variant="outline">
                Return to catalog
              </Button>
            </div>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
