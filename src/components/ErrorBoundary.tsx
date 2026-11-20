import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message || 'An unexpected error occurred.' };
  }

  render() {
    if (this.state.hasError) {
      let parsedError = this.state.message;
      try {
        const obj = JSON.parse(this.state.message);
        if (obj && typeof obj.error === 'string') {
          parsedError = `${obj.error} (${obj.operationType || 'operation'} on ${obj.path || 'database'})`;
        }
      } catch {
        // Use raw message
      }

      return (
        <div className="min-h-screen bg-[#FAF9F6] flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-white border border-[#E7E5E0] rounded-2xl p-8">
            <div className="flex items-center gap-3 text-[#DC2626] mb-4">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <h1 className="text-xl font-bold text-[#0F172A]">Something interrupted your session</h1>
            </div>
            <p className="text-sm text-[#475569] leading-relaxed mb-6 break-words">
              {parsedError}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#312E81] text-white text-sm font-medium hover:bg-[#4338CA] transition-colors cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              Reload Sikshalite
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
