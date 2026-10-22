import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';
import { ErrorState } from '@/components/ui/feedback';
import { resetFailedLazyImports } from '@/lib/retryableLazy';

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * When this changes while an error is shown, the boundary resets — pass the
   * route pathname so navigating away from a crashed page recovers in-app
   * instead of requiring a full reload.
   */
  resetKey?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors from the subtree so a single throw does not
 * unmount the whole app (blank screen). Renders a design-system fallback with
 * the error message and a Retry button that reloads the page.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('ErrorBoundary caught an error', error, info.componentStack);
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      // A failed route chunk would otherwise re-throw its cached rejection.
      resetFailedLazyImports();
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div className="flex min-h-screen items-center justify-center p-4">
          <div className="w-full max-w-lg">
            <ErrorState error={error} headingLevel={1} onRetry={() => window.location.reload()} />
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
