import { Component, Suspense } from "react";
import { useLocation } from "react-router-dom";

class RouteErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError(error) {
    if (error?.name !== "ChunkLoadError" && error?.code !== "CSS_CHUNK_LOAD_FAILED") throw error;
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error("Could not load a MusicDeck page:", error);
  }

  componentDidUpdate(previous) {
    if (this.state.failed && previous.path !== this.props.path) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="loading" role="alert">
      <p>This page could not load. Reconnect if you are offline, then reload.</p>
      <button type="button" onClick={() => window.location.reload()}>Reload MusicDeck</button>
    </div>;
  }
}

export default function RouteBoundary({ children }) {
  const { pathname } = useLocation();
  return <RouteErrorBoundary path={pathname}>
    <Suspense fallback={<div className="loading" role="status">Loading page…</div>}>
      {children}
    </Suspense>
  </RouteErrorBoundary>;
}
