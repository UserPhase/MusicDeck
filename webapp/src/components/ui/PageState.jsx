export function LoadingState({ children = "Loading..." }) {
  return <div className="loading">{children}</div>;
}

export function ErrorState({ children }) {
  return <div className="error">{children}</div>;
}

export function EmptyState({ children }) {
  return <div className="library-empty">{children}</div>;
}
