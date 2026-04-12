import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";

export default function PluginsTab({ onPluginsChange }) {
  const [plugins, setPlugins] = useState([]);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    setLoading(true);
    try {
      const list = await invoke("list_plugins");
      setPlugins(list);
      onPluginsChange?.(list.filter((p) => p.enabled));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();

    let lastJson = "";

    const poll = setInterval(async () => {
      try {
        const list = await invoke("list_plugins");
        const json = JSON.stringify(
          list.map((p) => ({ id: p.id, enabled: p.enabled })),
        );
        if (json !== lastJson) {
          lastJson = json;
          setPlugins(list);
          onPluginsChange?.(list.filter((p) => p.enabled));
        }
      } catch (e) {
        console.error(e);
      }
    }, 2000);

    return () => clearInterval(poll);
  }, []);

  const toggle = async (plugin) => {
    const next = !plugin.enabled;
    await invoke("set_plugin_enabled", { pluginId: plugin.id, enabled: next });
    const updated = plugins.map((p) =>
      p.id === plugin.id ? { ...p, enabled: next } : p,
    );
    setPlugins(updated);
    onPluginsChange?.(updated.filter((p) => p.enabled));
  };

  const openFolder = async () => {
    const dir = await invoke("get_main_dir", { folderName: "plugins" });
    await invoke("open_item", { path: dir });
  };

  if (loading)
    return (
      <div className="flex items-center justify-center h-32 text-base-content/50 text-sm">
        Loading plugins...
      </div>
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between items-center">
        <p className="text-xs text-base-content/50">
          Place a folder with <code className="font-mono">manifest.json</code> +{" "}
          <code className="font-mono">index.js</code> in{" "}
          <code className="font-mono">plugins/</code>
        </p>
        <button className="btn btn-sm btn-outline" onClick={openFolder}>
          Open folder
        </button>
      </div>

      {plugins.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 h-40 text-base-content/40 text-sm rounded-box border border-dashed border-base-content/20">
          <span className="text-2xl">🧩</span>
          <span>No plugins installed</span>
        </div>
      ) : (
        plugins.map((plugin) => (
          <div
            key={plugin.id}
            className={`flex items-center gap-3 p-3 rounded-box border transition-colors ${
              plugin.enabled
                ? "border-primary/40 bg-primary/5"
                : "border-base-content/10 bg-base-100"
            }`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sm">{plugin.name}</span>
                <span className="text-xs text-base-content/40 font-mono">
                  v{plugin.version}
                </span>
              </div>
              {plugin.description && (
                <div className="text-xs text-base-content/60 mt-0.5 prose prose-sm max-w-none">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ href, children }) => {
                        const handleClick = async (e) => {
                          e.preventDefault();

                          if (!href) return;

                          // sécurité minimale
                          if (
                            href.startsWith("http://") ||
                            href.startsWith("https://")
                          ) {
                            await openUrl(href);
                          }
                        };

                        return (
                          <span
                            onClick={handleClick}
                            className="text-primary cursor-pointer hover:underline"
                          >
                            {children}
                          </span>
                        );
                      },
                    }}
                  >
                    {plugin.description}
                  </ReactMarkdown>
                </div>
              )}
              <div className="flex gap-1 flex-wrap mt-0.5">
                {plugin.authors.map((a, i) =>
                  a.url ? (
                    <span
                      key={i}
                      onClick={() => openUrl(a.url)}
                      className="text-xs text-primary/70 hover:text-primary cursor-pointer"
                    >
                      {a.name}
                      {i < plugin.authors.length - 1 ? "," : ""}
                    </span>
                  ) : (
                    <span key={i} className="text-xs text-base-content/40">
                      {a.name}
                      {i < plugin.authors.length - 1 ? "," : ""}
                    </span>
                  ),
                )}
              </div>
            </div>
            <input
              type="checkbox"
              className="toggle toggle-sm toggle-primary"
              checked={plugin.enabled}
              onChange={() => toggle(plugin)}
            />
          </div>
        ))
      )}
    </div>
  );
}
