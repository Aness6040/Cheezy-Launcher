import { useRef, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as Babel from "@babel/standalone";
import React from "react";

export function usePlugins(pluginAPIProxy) {
  const pluginRegistryRef = useRef({});
  const [pluginTabs, setPluginTabs] = useState([]);
  const [pluginReloadKey, setPluginReloadKey] = useState(0);

  const simpleHash = (str) => {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return h;
  };

  const handlePluginsChange = async (enabledPlugins) => {
    const registry = pluginRegistryRef.current;
    const enabledIds = new Set(enabledPlugins.map((p) => p.id));

    for (const id of Object.keys(registry)) {
      if (!enabledIds.has(id)) {
        try {
          registry[id].cleanup?.();
        } catch (e) {}
        delete registry[id];
      }
    }

    const newTabs = [];

    for (const plugin of enabledPlugins) {
      try {
        const code = await invoke("read_plugin_script", {
          pluginId: plugin.id,
        });
        const hash = simpleHash(code);

        if (registry[plugin.id]?.hash === hash) {
          newTabs.push(...registry[plugin.id].tabs);
          continue;
        }

        if (registry[plugin.id]) {
          try {
            registry[plugin.id].cleanup?.();
          } catch {}
          delete registry[plugin.id];
        }

        let registered = null;
        const sandboxedRegister = (def) => {
          registered = def;
        };

        let compiled;
        try {
          compiled = Babel.transform(code, {
            presets: ["react", "typescript"],
            filename: "plugin.tsx",
          }).code;
        } catch (e) {
          console.error(`Babel error in plugin ${plugin.id}:`, e);
          continue;
        }

        try {
          new Function("__ptRegisterPlugin", "React", "pluginAPI", compiled)(
            sandboxedRegister,
            React,
            pluginAPIProxy,
          );
        } catch (e) {
          console.error(`Runtime error in plugin ${plugin.id}:`, e);
          continue;
        }

        if (!registered) continue;

        const loadedTabs = (registered.tabs || []).map((tab) => ({
          pluginId: plugin.id,
          tabId: tab.id,
          label: tab.label,
          rpcState: tab.rpcState || tab.label,
        }));

        registry[plugin.id] = {
          hash,
          tabs: loadedTabs,
          cleanup: registered.cleanup || null,
          registered,
        };

        newTabs.push(...loadedTabs);
      } catch (e) {
        console.error(`Failed to load plugin ${plugin.id}:`, e);
      }
    }

    setPluginTabs(newTabs);
  };

  useEffect(() => {
    let lastJson = "";
    const poll = setInterval(async () => {
      try {
        const list = await invoke("list_plugins");
        const json = JSON.stringify(
          list.map((p) => ({ id: p.id, enabled: p.enabled })),
        );
        if (json !== lastJson) {
          lastJson = json;
          handlePluginsChange(list.filter((p) => p.enabled));
        }
      } catch (e) {
        console.error(e);
      }
    }, 5000);
    return () => clearInterval(poll);
  }, [pluginReloadKey]);

  useEffect(() => {
    return () => {
      for (const entry of Object.values(pluginRegistryRef.current)) {
        try {
          entry.cleanup?.();
        } catch {}
      }
    };
  }, []);

  const reloadPlugins = () => {
    pluginRegistryRef.current = {};
    setPluginReloadKey((k) => k + 1);
    handlePluginsChange([]);
  };

  return { pluginTabs, pluginRegistryRef, handlePluginsChange, reloadPlugins };
}
