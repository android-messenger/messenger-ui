import {Component, type ErrorInfo, type ReactNode} from "react";
import {logger} from "@/shared/logger/logger.ts";

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
}
interface State {
    hasError: boolean;
}

/**
 * App-level error boundary: a render/runtime error in the tree no longer blanks the whole app —
 * it shows a minimal recoverable fallback with a reload. React requires a class component for this.
 */
export class ErrorBoundary extends Component<Props, State> {
    state: State = {hasError: false};

    static getDerivedStateFromError(): State {
        return {hasError: true};
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        logger.error("Unhandled UI error", error);
        logger.debug("component stack", info.componentStack ?? "");
    }

    render() {
        if (!this.state.hasError) return this.props.children;
        if (this.props.fallback) return this.props.fallback;
        return (
            <div className="min-h-dvh flex items-center justify-center bg-gray-200 p-6">
                <div className="bg-white rounded-xl shadow p-6 text-center max-w-sm">
                    <div className="text-3xl mb-2">⚠️</div>
                    <p className="text-gray-700 mb-4">Algo salió mal / Something went wrong</p>
                    <button
                        onClick={() => window.location.reload()}
                        className="px-4 py-2 rounded bg-teal-950 text-white hover:bg-teal-900"
                    >
                        Recargar / Reload
                    </button>
                </div>
            </div>
        );
    }
}
