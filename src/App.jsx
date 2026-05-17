import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import AnsiToHtml from "ansi-to-html";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { confirm } from "@tauri-apps/plugin-dialog";
import { joinPath, getGmlDir } from "./pathUtils";
import ReactMarkdown from "react-markdown";
import { check } from "@tauri-apps/plugin-updater";

import { start, setActivity, clearActivity, destroy } from "tauri-plugin-drpc";
import { Activity, Assets, Timestamps } from "tauri-plugin-drpc/activity";

import ManageMods from "./ManageMods";
import ManageGMLoader from "./ManageGMLoader";
import BrowseMods from "./BrowseMods";
import SettingsTab from "./SettingsTab";
import PluginsTab from "./PluginsTab";
import PluginHost from "./PluginHost";
import { usePlugins } from "./usePlugins";

function LogPanel({ logs, onClear }) {
  const convert = new AnsiToHtml();
  const logsEndRef = useRef(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div className="mt-4 p-3 bg-base-300 rounded-box h-40 overflow-y-auto text-xs font-mono flex flex-col">
      <div className="flex justify-between items-center mb-2">
        <span className="font-bold">Logs</span>
        <button
          onClick={onClear}
          className="btn btn-sm btn-outline"
          title="Clear logs"
        >
          🗑️
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {logs.length === 0 && <p>No logs yet...</p>}
        {logs.map((log, i) => (
          <div
            key={i}
            className="break-words"
            dangerouslySetInnerHTML={{ __html: convert.toHtml(log) }}
          />
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}

function App() {
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);

  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const update = await check();
        if (update?.available) {
          setUpdateInfo(update);
          setShowUpdateModal(true);
        }
      } catch (e) {
        console.error("Update check failed:", e);
      }
    };
    checkUpdate();
  }, []);

  const sanitizeName = (name) => name.replace(/[<>:"/\\|?*]/g, "_").trim();
  const [activeTab, setActiveTab] = useState("tab1");
  const [modsDir, setModsDir] = useState(null);
  const [overwiteDir, setOverwiteDir] = useState(null);
  const [logs, setLogs] = useState([]);
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [settings, setSettings] = useState({
    theme: "light",
    game_dir: "",
    discord_rpc: undefined,
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "light");
  }, []);

  const addLog = (message) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, `[${time}] ${message}`]);
  };

  useEffect(() => {
    invoke("list_plugins")
      .then((list) => handlePluginsChange(list.filter((p) => p.enabled)))
      .catch(console.error);
  }, []);

  const activeTabRef = useRef(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  const pluginAPIRef = useRef({});
  pluginAPIRef.current = {
    addLog,
    invoke,
    openUrl,
    joinPath,
    getGmlDir,
    getCurrentTabId: () => activeTabRef.current.split(":")[2],
    isActiveTab: (id) =>
      activeTabRef.current ===
      `plugin:${activeTabRef.current.split(":")[1]}:${id}`,
    get activeTab() {
      return activeTabRef.current;
    },
  };

  const pluginAPIProxy = useRef(
    new Proxy({}, { get: (_, key) => pluginAPIRef.current[key] }),
  ).current;

  const { pluginTabs, pluginRegistryRef, handlePluginsChange, reloadPlugins } =
    usePlugins(pluginAPIProxy);

  const staticTabs = [
    { id: "tab1", label: "Manage Mods", rpcState: "Managing mods" },
    { id: "tab2", label: "GMLoader Mods", rpcState: "GMLoader mods" },
    { id: "tab3", label: "Browse Mods", rpcState: "Browsing GameBanana" },
  ];

  const Ftabs = [
    ...staticTabs,
    ...pluginTabs.map((t) => ({
      id: `plugin:${t.pluginId}:${t.tabId}`,
      label: t.label,
      rpcState: t.rpcState || t.label,
    })),
  ];

  const rpcStartTime = useRef(Date.now());
  const getRpcState = (tabId) => {
    if (tabId === "settings") return "In settings";
    return Ftabs.find((t) => t.id === tabId)?.rpcState || "Menu";
  };

  useEffect(() => {
    if (settings.discord_rpc === undefined) return;

    if (settings.discord_rpc) {
      start("1492450589278212237").catch(console.error);
    } else {
      clearActivity().finally(() => destroy());
      return;
    }

    const activity = new Activity()
      .setDetails("Pizza Tower Mod Manager")
      .setState(getRpcState(activeTab))
      .setAssets(
        new Assets().setLargeImage("logo").setLargeText("PT Mod Manager"),
      )
      .setTimestamps(new Timestamps(rpcStartTime.current));

    setActivity(activity).catch(console.error);

    return () => {
      destroy().catch(() => {});
    };
  }, [settings.discord_rpc, activeTab]);

  const applyTheme = async (theme) => {
    document
      .querySelectorAll("[data-theme-custom]")
      .forEach((el) => el.remove());

    if (!theme) theme = "light";
    document.documentElement.setAttribute("data-theme", theme);

    const getColorSchemeFromStyle = (styleEl) => {
      const sheet = styleEl.sheet;
      if (!sheet) return null;
      for (const rule of sheet.cssRules) {
        if (rule.selectorText === ":root") {
          return rule.style.getPropertyValue("color-scheme").trim();
        }
      }
      return null;
    };

    let th = theme === "dark" ? "dark" : "light";
    try {
      const exeDir = await invoke("get_main_dir", { folderName: "" });
      const css = await invoke("read_item", {
        path: joinPath(exeDir, "themes", `${theme}.css`),
      });
      const el = document.createElement("style");
      el.setAttribute("data-theme-custom", theme);
      el.textContent = css;
      document.head.appendChild(el);
      const scheme = getColorSchemeFromStyle(el);
      th = scheme === null ? "light" : scheme;
    } catch (e) {}
    try {
      await getCurrentWindow().setTheme(th);
    } catch (e) {}
  };

  useEffect(() => {
    const unlisten = listen("download-progress", (event) => {
      setDownloadProgress(JSON.parse(event.payload));
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    invoke("get_main_dir", { folderName: "mods" })
      .then(setModsDir)
      .catch(console.error);
    invoke("get_main_dir", { folderName: "overwrite" })
      .then(setOverwiteDir)
      .catch(console.error);
    invoke("get_settings")
      .then((s) => {
        setSettings(s);
        applyTheme(s.theme);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    const handleContextMenu = (e) => e.preventDefault();
    window.addEventListener("contextmenu", handleContextMenu);
    return () => window.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  useEffect(() => {
    let unlisten;
    onOpenUrl((urls) => {
      for (const url of urls) {
        const match = url.match(/mmdl\/(\d+),([^,]+),(\d+)/);
        if (match) {
          const [, fileId, , modId] = match;
          handleGBInstall(modId, null, fileId);
        }
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [modsDir]);

  const handleGBInstall = async (modId, modName, fileId, prefetched = null) => {
    addLog(`Trying to install ${modName}...`);
    try {
      let files, description, rootCatId, rootCatParentId, data;

      if (prefetched) {
        ({ files, description, rootCatId, rootCatParentId } = prefetched);
        data = {
          _aSubmitter: { _sName: prefetched.mod.owner },
          _aRootCategory: { _sName: prefetched.mod.cat, _idRow: rootCatId },
          _aPreviewMedia: null,
        };
      } else {
        const res = await fetch(
          `https://gamebanana.com/apiv11/Mod/${modId}?_csvProperties=_aFiles,_sDescription,_aRootCategory,_aSubmitter,_aPreviewMedia,_sName`,
        );
        data = await res.json();
        modName = data._sName || modName || modId;
        files = data._aFiles ? Object.values(data._aFiles) : [];
        description = data._sDescription || "";
        rootCatId = data._aRootCategory?._idRow;
        rootCatParentId = data._aRootCategory?._idParentCategoryRow;
      }

      const CYOP_IDS = [25679, 22962, 25680];
      const GMLOADER_ID = 36921;

      modName = sanitizeName(String(modName));

      const fileList = Array.isArray(files) ? files : Object.values(files);
      const file =
        fileList.find((f) => String(f._idRow) === String(fileId)) ??
        fileList[0];
      if (!file) {
        addLog(`No file found for ${modName}`);
        return;
      }

      const isCYOP =
        CYOP_IDS.includes(rootCatId) || CYOP_IDS.includes(rootCatParentId);
      const isGMLoader = rootCatId === GMLOADER_ID;

      let targetModsPath = modsDir;
      let writeModJson = true;

      if (isCYOP) {
        const settingsData = await invoke("get_settings");
        targetModsPath = joinPath(settingsData.game_data_dir, "towers");
        writeModJson = false;
      } else if (isGMLoader) {
        targetModsPath = getGmlDir(modsDir);
        writeModJson = false;
      }

      if (
        !(await confirm(`Install "${modName}"?`, {
          title: `Downloading ${file._sFile} ...`,
          kind: "info",
        }))
      )
        return;

      addLog(`Downloading ${file._sFile}...`);
      setDownloadProgress({
        file_name: file._sFile,
        percent: 0,
        downloaded_mb: 0,
        total_mb: 0,
      });

      await invoke("download_and_install_mod", {
        url: file._sDownloadUrl,
        modName,
        modsPath: targetModsPath,
        fileName: file._sFile,
      });

      if (isCYOP)
        await invoke("flatten_mod_dir", {
          modPath: joinPath(targetModsPath, modName),
        });

      if (writeModJson) {
        const preview =
          prefetched?.mod?.preview ||
          (() => {
            const img = data._aPreviewMedia?._aImages?.[0];
            return img ? `${img._sBaseUrl}/${img._sFile220 ?? img._sFile}` : "";
          })();
        const modJson = {
          title: modName,
          preview,
          submitter: prefetched?.mod?.owner || data._aSubmitter?._sName || "",
          cat: prefetched?.mod?.cat || data._aRootCategory?._sName || "",
          description,
          filedescription: file._sDescription || "",
          homepage:
            prefetched?.mod?.url || `https://gamebanana.com/mods/${modId}`,
          lastupdate: new Date().toISOString(),
        };
        await invoke("edit_item", {
          path: joinPath(targetModsPath, modName, "mod.json"),
          content: JSON.stringify(modJson, null, 2),
        });
      }

      setDownloadProgress(null);
      addLog(`✓ Installed: ${modName}`);
      window.alert(`"${modName}" installed successfully!`);
    } catch (e) {
      setDownloadProgress(null);
      addLog(`Install error: ${e}`);
    }
  };

  const handleDropInstall = async (filePath, targetDir) => {
    const fileName = filePath.split(/[\\/]/).pop();
    const modName = sanitizeName(fileName.replace(/\.(zip|rar|7z)$/i, ""));
    try {
      addLog(`Installing dropped mod: ${modName}...`);
      await invoke("install_local_mod", {
        modName,
        modsPath: targetDir,
        filePath,
      });
      addLog(`✓ Installed: ${modName}`);
    } catch (e) {
      addLog(`Drop install error: ${e}`);
    }
  };

  return (
    <div>
      {showUpdateModal && updateInfo && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70">
          <div className="bg-base-100 rounded-box shadow-xl p-6 w-[500px] flex flex-col gap-4">
            <h2 className="text-xl font-bold text-center">Update Available</h2>
            <p className="text-sm opacity-80">
              A new version of Cheezy Launcher is available.
            </p>
            <div className="bg-base-200 p-3 rounded-box font-mono max-h-40 overflow-auto">
              <div className="font-bold mb-2">Info:</div>
              <ReactMarkdown>
                {updateInfo?.body || "No changelog provided"}
              </ReactMarkdown>
            </div>
            <div className="flex gap-2 justify-end mt-2">
              <button
                className="btn btn-error btn-sm"
                onClick={() => setShowUpdateModal(false)}
              >
                Later
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={async () => await updateInfo.downloadAndInstall()}
              >
                Update now
              </button>
            </div>
          </div>
        </div>
      )}

      <div role="tablist" className="tabs tabs-border flex justify-between">
        <div className="flex gap-1 tabs-border">
          {Ftabs.map((tab) => (
            <a
              key={tab.id}
              role="tab"
              className={`tab ${activeTab === tab.id ? "tab-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </a>
          ))}
        </div>
        <div className="flex gap-1">
          <a
            role="tab"
            className={`tab ${activeTab === "plugins" ? "tab-active" : ""}`}
            onClick={() => setActiveTab("plugins")}
          >
            Plugins
          </a>

          <a
            role="tab"
            className={`tab ${activeTab === "settings" ? "tab-active" : ""}`}
            onClick={() => setActiveTab("settings")}
          >
            Settings
          </a>
        </div>
      </div>

      <div className="flex-1 p-4 bg-base-200 rounded-box">
        <div
          className="flex-1 overflow-auto"
          style={{
            height: `calc(100vh - ${activeTab === "tab1" || activeTab === "tab2" ? "270px" : "90px"})`,
          }}
        >
          <div style={{ display: activeTab === "tab1" ? "" : "none", height: "100%" }}>
            <ManageMods
              modsDir={modsDir}
              overwiteDir={overwiteDir}
              addLog={addLog}
              logs={logs}
              onDropInstall={(p) => handleDropInstall(p, modsDir)}
            />
          </div>
          <div style={{ display: activeTab === "tab2" ? "" : "none", height: "100%" }}>
            <ManageGMLoader
              modsDir={modsDir}
              addLog={addLog}
              onDropInstall={(p) => handleDropInstall(p, getGmlDir(modsDir))}
            />
          </div>
          <div style={{ display: activeTab === "tab3" ? "" : "none", height: "100%" }}>
            <BrowseMods
              modsDir={modsDir}
              addLog={addLog}
              onInstall={handleGBInstall}
            />
          </div>
          <div style={{ display: activeTab === "plugins" ? "" : "none", height: "100%" }}>
            <PluginsTab
              onPluginsChange={handlePluginsChange}
              onReload={reloadPlugins}
            />
          </div>
          {(() => {
            if (!activeTab.startsWith("plugin:")) return null;
            const [, pluginId, tabId] = activeTab.split(":");
            return (
              <div style={{ height: "100%" }}>
                <PluginHost
                  key={activeTab}
                  registered={pluginRegistryRef.current[pluginId]?.registered}
                  tabId={tabId}
                  pluginAPI={pluginAPIProxy}
                />
              </div>
            );
          })()}
          <div style={{ display: activeTab === "settings" ? "" : "none", height: "100%" }}>
            <SettingsTab
              onSave={(s) => setSettings(s)}
              applyTheme={applyTheme}
            />
          </div>
        </div>
        {(activeTab === "tab1" || activeTab === "tab2") && (
          <div className="mt-auto">
            <LogPanel logs={logs} onClear={() => setLogs([])} />
          </div>
        )}
      </div>

      {downloadProgress && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-base-100 rounded-box shadow-xl p-5 w-96 flex flex-col gap-3 text-center">
            <h3 className="font-bold text-sm truncate">
              Downloading {downloadProgress.file_name}
            </h3>
            <progress
              className="progress progress-primary w-full"
              value={downloadProgress.percent}
              max="100"
            />
            <span className="text-xs font-mono">
              {downloadProgress.percent}% ({downloadProgress.downloaded_mb} MB /{" "}
              {downloadProgress.total_mb} MB)
            </span>
            <button
              className="btn btn-sm btn-outline btn-error"
              onClick={async () => {
                const confirmed = await confirm(
                  "Are you sure you want to cancel this download?",
                  {
                    title: "Cancel Download",
                    kind: "warning",
                  },
                );
                if (confirmed) {
                  setDownloadProgress(null);
                }
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
