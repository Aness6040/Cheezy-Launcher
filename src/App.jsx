import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import AnsiToHtml from "ansi-to-html";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { confirm } from "@tauri-apps/plugin-dialog";

import {
  start,
  stop,
  setActivity,
  clearActivity,
  destroy,
} from "tauri-plugin-drpc";
import { Activity, Assets, Timestamps } from "tauri-plugin-drpc/activity";

import ManageMods from "./ManageMods";
import ManageGMLoader from "./ManageGMLoader";
import BrowseMods from "./BrowseMods";
import SettingsTab from "./SettingsTab";

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
  const sanitizeName = (name) => name.replace(/[<>:"/\\|?*]/g, "_").trim();
  const [activeTab, setActiveTab] = useState("tab1");
  const [modsDir, setModsDir] = useState(null);
  const [overwiteDir, setOverwiteDir] = useState(null);
  const [logs, setLogs] = useState([]);
  const [settings, setSettings] = useState({
    theme: "light",
    game_dir: "",
    discord_rpc: undefined,
  });

  useEffect(() => {
    if (settings.discord_rpc === undefined) return;

    console.log("[RPC] discord_rpc changed:", settings.discord_rpc);

    if (settings.discord_rpc) {
      start("1492450589278212237")
        .then(() => console.log("[RPC] started"))
        .catch((e) => console.error("[RPC] start error:", e));
    } else {
      clearActivity()
        .catch(() => {})
        .finally(() => {
          destroy().catch(() => {});
        });
    }
    return () => {
      destroy().catch(() => {});
    };
  }, [settings.discord_rpc]);
  const rpcStartTime = useRef(Date.now());
  useEffect(() => {
    if (!settings.discord_rpc) return;

    const labels = {
      tab1: "Managing mods",
      tab2: "GMLoader mods",
      tab3: "Browsing GameBanana",
      settings: "In settings",
    };

    const activity = new Activity()
      .setDetails("Pizza Tower Mod Manager")
      .setState(labels[activeTab] || "Menu")
      .setAssets(
        new Assets().setLargeImage("logo").setLargeText("PT Mod Manager"),
      )
      .setTimestamps(new Timestamps(rpcStartTime.current));

    setActivity(activity).catch(() => {});
  }, [activeTab, settings.discord_rpc]);

  const applyTheme = async (theme) => {
    document
      .querySelectorAll("[data-theme-custom]")
      .forEach((el) => el.remove());
    document.documentElement.setAttribute("data-theme", theme);
    try {
      const exeDir = await invoke("get_main_dir", { folderName: "" });
      let css = await invoke("read_item", {
        path: `${exeDir}\\themes\\${theme}.css`,
      });
      const el = document.createElement("style");
      el.setAttribute("data-theme-custom", theme);
      el.textContent = css;
      document.head.appendChild(el);
    } catch (e) {}
  };

  const addLog = (message) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, `[${time}] ${message}`]);
  };

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
        // reconstruire data pour le mod.json
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
        targetModsPath = `${settingsData.game_data_dir}\\towers`;
        writeModJson = false;
      } else if (isGMLoader) {
        targetModsPath = modsDir.replace(/[/\\]mods$/, "\\mods_GML");
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
      const bytes = await invoke("fetch_file", { url: file._sDownloadUrl });
      await invoke("download_mod", {
        modName,
        modsPath: targetModsPath,
        fileBytes: bytes,
        fileName: file._sFile,
      });

      if (isCYOP)
        await invoke("flatten_mod_dir", {
          modPath: `${targetModsPath}\\${modName}`,
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
          path: `${targetModsPath}\\${modName}\\mod.json`,
          content: JSON.stringify(modJson, null, 2),
        });
      }

      addLog(`✓ Installed: ${modName}`);
      window.alert(`"${modName}" installed successfully!`);
    } catch (e) {
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

  const tabs = [
    { id: "tab1", label: "Manage Mods" },
    { id: "tab2", label: "GMLoader Mods" },
    { id: "tab3", label: "Browse Mods" },
  ];

  return (
    <div>
      <div role="tablist" className="tabs tabs-border flex justify-between">
        <div className="flex gap-1 tabs-border">
          {tabs.map((tab) => (
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

        <a
          role="tab"
          className={`tab ${activeTab === "settings" ? "tab-active" : ""}`}
          onClick={() => setActiveTab("settings")}
        >
          Settings
        </a>
      </div>
      <div className="flex-1 p-4 bg-base-200 rounded-box">
        <div
          className="flex-1 overflow-auto"
          style={{
            height: `calc(100vh - ${activeTab === "tab1" || activeTab === "tab2" ? "270px" : "90px"})`,
          }}
        >
          {activeTab === "tab1" && (
            <ManageMods
              modsDir={modsDir}
              overwiteDir={overwiteDir}
              addLog={addLog}
              logs={logs}
              onDropInstall={(p) => handleDropInstall(p, modsDir)}
            />
          )}
          {activeTab === "tab2" && (
            <ManageGMLoader
              modsDir={modsDir}
              addLog={addLog}
              onDropInstall={(p) =>
                handleDropInstall(
                  p,
                  modsDir.replace(/[/\\]mods$/, "\\mods_GML"),
                )
              }
            />
          )}
          {activeTab === "tab3" && (
            <BrowseMods
              modsDir={modsDir}
              addLog={addLog}
              onInstall={handleGBInstall}
            />
          )}
          {activeTab === "settings" && (
            <SettingsTab
              onSave={(s) => setSettings(s)}
              applyTheme={applyTheme}
            />
          )}
        </div>
        {(activeTab === "tab1" || activeTab === "tab2") && (
          <div className="mt-auto">
            <LogPanel logs={logs} onClear={() => setLogs([])} />
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
