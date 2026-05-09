import { useState, useEffect, useMemo } from "react";
import React from "react";

export default function PluginHost({ registered, tabId, pluginAPI }) {
  if (!registered) return <div>Loading...</div>;
  const tab = (registered.tabs || []).find((t) => t.id === tabId);
  return tab ? React.createElement(tab.component, pluginAPI) : null;
}
