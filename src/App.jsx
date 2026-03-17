import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import AnsiToHtml from "ansi-to-html";
import chalk from 'chalk';

const GAME_DIR = "D:\\SteamLibrary\\steamapps\\common\\Pizza Tower";

const themes = [
  "light",
  "dark"
];

function ModCard({ modPath, modName }) {
  const [modData, setModData] = useState(null);

  useEffect(() => {
    const loadMod = async () => {
      try {
        const content = await invoke("read_item", { path: `${modPath}/mod.json` });
        const data = JSON.parse(content); // parse JSON si présent
        setModData(data);
      } catch (e) {
        console.warn(`No mod.json for ${modName}`, e);
        setModData(null); // fallback si pas de mod.json
      }
    };

    loadMod();
  }, [modPath, modName]);

  const title = modData?.title || modName;
  const preview = modData?.preview || null;
  const submitter = modData?.submitter || "Unknown";
  const cat = modData?.cat || "Unknown";
  const description = modData?.description || "";

  return (
    <div className="rounded border border-base-300 hover:border-primary transition-colors shadow-md overflow-hidden">
      {preview && (
        <img src={preview} alt={title} className="w-full h-32 object-cover" />
      )}
      <div className="card-body flex flex-col justify-center items-center p-4 text-center">
        <h2 className="card-title text-sm font-bold truncate">{title}</h2>
        <p className="text-xs text-gray-400 truncate">{submitter} • {cat}</p>
        {description && <p className="text-xs mt-1 line-clamp-2">{description}</p>}
        {modData?.homepage && (
          <a
            href={modData.homepage}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-500 text-xs mt-1 hover:underline"
          >
            {modData.homepage}
          </a>
        )}
      </div>
    </div>
  );
}


function OverwriteCheckbox({ overwiteDir }) {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleToggle = async () => {
    setLoading(true);
    try {
      if (!enabled) {
        await invoke("apply_overwrite", { overwritePath: overwiteDir, targetPath: GAME_DIR });
      } else {
        await invoke("remove_overwrite", { overwritePath: overwiteDir, targetPath: GAME_DIR });
      }
      setEnabled(!enabled);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        className="checkbox checkbox-primary checkbox-sm"
        checked={enabled}
        disabled={loading || !overwiteDir}
        onChange={handleToggle}
      />
      <span className="text-sm">
        {loading ? "..." : enabled ? "Overwrite actif" : "Overwrite"}
      </span>
    </label>
  );
}

function Tab1({ modsDir, overwiteDir, addLog, logs }) {
  const [mods, setMods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");

  const fetchMods = () => {
    if (!modsDir) return;

    invoke("list_mods", { modsPath: modsDir })
      .then((folders) => {
        setMods(folders);
      })
      .catch((e) => {
        console.error(e);
        addLog(`Error loading mods`);
      })
      .finally(() => setLoading(false));
  };

  const filteredMods = mods.filter(mod =>
    mod.toLowerCase().includes(searchTerm.toLowerCase())
  );

  useEffect(() => {
    fetchMods();
    const interval = setInterval(fetchMods, 2000);
    return () => clearInterval(interval);
  }, [modsDir]);

  const handleRunFile = () => {
    const path = `${GAME_DIR}//PizzaTower.exe`;

    invoke("run_file", { path })
      .then(() => {
        addLog(chalk.cyan("Game launched"));
      })
      .catch((e) => {
        console.error(e);
        addLog(chalk.red("Error launching game"));
      });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="mb-3 flex gap-2 flex-shrink-0">
        <input
          type="text"
          placeholder="Search mods..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="input input-bordered input-sm flex-1"
        />
        <button
          className="btn btn-sm btn-primary"
          onClick={() => setSearchTerm("")}
        >
          Clear
        </button>
      </div>

      <div className="flex gap-3 mb-3 flex-shrink-0">
        <button onClick={handleRunFile} className="btn btn-primary">
          Exec Test
        </button>
        <button
          className="btn btn-secondary"
          onClick={() =>
            invoke("apply_xdelta_patch", { source: "", patch: "", output: "" })
              .then(() => alert("Patch appliqué !"))
              .catch(console.error)
          }
        >
          Patch Test
        </button>
        <button
          className="btn btn-secondary"
          onClick={() =>
            invoke("open_item", { path: GAME_DIR})
          }
        >
          Open Folder Test
        </button>
        <OverwriteCheckbox overwiteDir={overwiteDir} />
      </div>

      {/* Zone scrollable */}
      <div className="flex-1 overflow-auto">
        {loading && <p className="text-sm">Loading...</p>}
        {!loading && mods.length === 0 && (
          <p className="text-sm">No mods found in {modsDir}</p>
        )}
        {!loading && mods.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {filteredMods.map((mod) => (
              <ModCard key={mod} modName={mod} modPath={`${modsDir}/${mod}`} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsTab() {
  const [settings, setSettings] = useState({ theme: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
  invoke("get_settings")
    .then((data) => {
      setSettings(data);
      applyTheme(data.theme)
    })
    .catch(console.error)
    .finally(() => setLoading(false));
}, []);

  const applyTheme = (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
  };

  const handleChange = (e) => {
    const value = e.target.value;
    setSettings((prev) => ({ ...prev, [e.target.name]: e.target.value }));
    applyTheme(value);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const exeDir = await invoke("get_main_dir", { folderName: "" }); // renvoie exe_dir
      await invoke("edit_item", {
        path: `${exeDir}//settings.json`,
        content: JSON.stringify(settings, null, 2)
        });
      applyTheme(settings.theme);
      alert("Settings saved !");
    } catch (e) {
      console.error(e);
      alert("Error saving settings");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="text-primary-content">Loading settings...</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col">
        <label className="mb-1">Theme</label>
        <select
          name="theme"
          value={settings.theme}
          onChange={handleChange}
          className="select select-bordered select-sm"
        >
          {themes.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="btn btn-primary w-max"
      >
        {saving ? "Saving..." : "Save Settings"}
      </button>
    </div>
  );
}

function LogPanel({ logs, onClear }) {
  const convert = new AnsiToHtml();

  return (
    <div className="mt-4 p-3 bg-base-300 rounded-lg h-40 overflow-y-auto text-xs font-mono flex flex-col">
      <div className="flex justify-between items-center mb-2">
        <span className="font-bold">Logs</span>
        <button onClick={onClear} className="btn btn-sm btn-outline" title="Clear logs">🗑️</button>
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
      </div>
    </div>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState("tab1");
  const [modsDir, setModsDir] = useState(null);
  const [overwiteDir, setOverwiteDir] = useState(null);
  const [logs, setLogs] = useState([]);
  const [settings, setSettings] = useState({ theme: "light" });
  const addLog = (message) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${time}] ${message}`, ...prev]);
  };

  useEffect(() => {
    invoke("get_main_dir", { folderName: "mods" })
      .then((path) => setModsDir(path))
      .catch(console.error);

    invoke("get_main_dir", { folderName: "overwrite" })
      .then((path) => setOverwiteDir(path))
      .catch(console.error);

    invoke("get_settings")
      .then((data) => setSettings(data))
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (settings.theme) {
      document.documentElement.setAttribute("data-theme", settings.theme);
    }
  }, [settings.theme]);

  useEffect(() => {
  const handleContextMenu = (e) => {
    e.preventDefault(); // bloque le menu par défaut
  };
  window.addEventListener("contextmenu", handleContextMenu);

  return () => {
    window.removeEventListener("contextmenu", handleContextMenu);
  };
}, []);

  return (
  <div>
  <div role="tablist" className="tabs tabs-border flex justify-between">
    <div className="flex gap-1 tabs-border">
      <a role="tab" className={`tab ${activeTab === "tab1" ? "tab-active" : ""}`} onClick={() => setActiveTab("tab1")}>Tab 1</a>
      <a role="tab" className={`tab ${activeTab === "tab2" ? "tab-active" : ""}`} onClick={() => setActiveTab("tab2")}>Tab 2</a>
      <a role="tab" className={`tab ${activeTab === "tab3" ? "tab-active" : ""}`} onClick={() => setActiveTab("tab3")}>Tab 3</a>
    </div>
    <a role="tab" className={`tab ${activeTab === "settings" ? "tab-active" : ""}`} onClick={() => setActiveTab("settings")}>Settings</a>
  </div>
  <div className="flex-1 p-4 bg-base-200 rounded-lg">
    
    <div className="flex-1 overflow-auto" style={{ height: `calc(100vh - ${(activeTab === "tab1" || activeTab === "tab2") ? "270px" : "90px"})` }}>
      {activeTab === "tab1" && <Tab1 modsDir={modsDir} overwiteDir={overwiteDir} addLog={addLog} logs={logs} />}
      {activeTab === "tab2" && <p>2nd (will be GMLoader suuport)</p>}
      {activeTab === "tab3" && <p>3rd (will be maybe Gamebanana search like PO)</p>}
      {activeTab === "settings" && <SettingsTab />}
    </div>

    {(activeTab === "tab1" || activeTab === "tab2") && (
      <div className="mt-auto">
        <LogPanel logs={logs} onClear={() => setLogs([])}/>
      </div>
    )}

  </div>
</div>
);
}

export default App;