import React from "react";

class PluginErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error: String(error) };
  }
  render() {
    if (this.state.error)
      return (
        <div className="p-4 text-error text-sm rounded-box border border-error/30 bg-error/5">
          <p className="font-semibold mb-1">
            Plugin error — {this.props.tabId}
          </p>
          <pre className="text-xs overflow-auto whitespace-pre-wrap">
            {this.state.error}
          </pre>
        </div>
      );
    return this.props.children;
  }
}

export default function PluginHost({ registered, tabId, pluginAPI }) {
  if (!registered) return <div>Loading...</div>;
  const tab = (registered.tabs || []).find((t) => t.id === tabId);
  if (!tab) return null;

  return (
    <PluginErrorBoundary tabId={tabId}>
      {React.createElement(tab.component, pluginAPI)}
    </PluginErrorBoundary>
  );
}
