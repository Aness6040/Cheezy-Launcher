import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import AnsiToHtml from "ansi-to-html";
import chalk from 'chalk';

const GAME_DIR = "D:\\SteamLibrary\\steamapps\\common\\Pizza Tower";

const themes = [
  "light",
  "dark"
];

function ModCard({ modPath, modName, selected = false, onSelect }) {
  const [modData, setModData] = useState(null);

  useEffect(() => {
    const loadMod = async () => {
      try {
        const content = await invoke("read_item", { path: `${modPath}/mod.json` });
        const data = JSON.parse(content);
        setModData(data);
      } catch (e) {
        console.warn(`No mod.json for ${modName}`, e);
        setModData(null);
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
    <div
      className={`rounded border transition-colors shadow-md overflow-hidden cursor-pointer
                  ${selected ? "border-primary bg-primary/20" : "border-base-300 hover:border-primary"}`}
      onClick={onSelect}
    >
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

function Tab1({ modsDir, overwiteDir, addLog, logs }) {
  const [mods, setMods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedMod, setSelectedMod] = useState(null); 
  const [operationRunning, setOperationRunning] = useState(false);
  

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
    const unlisten = listen("prepare-log", (event) => {
        addLog(event.payload);
    });
    return () => { unlisten.then(f => f()); };
}, []);

  useEffect(() => {
    fetchMods();
    const interval = setInterval(fetchMods, 2000);
    return () => clearInterval(interval);
  }, [modsDir]);
  const handleRunFile = async () => {
  if (operationRunning) return;
  setOperationRunning(true);
  addLog(chalk.yellow("Preparing overwrite..."));

  try {
    const vfsRoot = await invoke("get_main_dir", { folderName: "vfs_root" });
    const settingsData = await invoke("get_settings");

    await invoke("prepare_overwrite", {
      mods: selectedMod ? [selectedMod] : [],
      modsPath: modsDir,
      overwritePath: overwiteDir,
      gameDir: GAME_DIR,
    });
    addLog(chalk.yellow("Mounting VFS..."));

    await invoke("mount_vfs", {
      gameDir: GAME_DIR,
      overwritePath: overwiteDir,
      vfsRoot,
    });
    addLog(chalk.cyan("Launching game..."));

    await invoke("launch_game", {
      vfsRoot,
      exeName: "PizzaTower.exe",
      launchArgs: settingsData.launch_args || [],
    });
    addLog(chalk.green("Game is running"));

    const poll = setInterval(async () => {
      const running = await invoke("is_operation_running");
      if (!running) {
        clearInterval(poll);
        addLog(chalk.yellow("Game closed, unmounting VFS..."));
        await invoke("unmount_vfs", { vfsRoot });
        addLog(chalk.green("VFS unmounted"));
        setOperationRunning(false);
      }
    }, 2000);

  } catch (e) {
    addLog(chalk.red(`Error: ${e}`));
    setOperationRunning(false);
  }
};
  const handleSelectMod = (modName) => {
  setSelectedMod(prev => prev === modName ? null : modName); // toggle
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
        <button onClick={handleRunFile} disabled={operationRunning} className={`btn btn-primary ${operationRunning ? "btn-disabled" : ""}`}>
          {operationRunning ? "Running..." : "Launch"}
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {loading && <p className="text-sm">Loading...</p>}
        {!loading && mods.length === 0 && (
          <p className="text-sm">No mods found in {modsDir}</p>
        )}
        {!loading && mods.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {filteredMods.map((mod) => (
              <ModCard
                key={mod}
                modName={mod}
                modPath={`${modsDir}/${mod}`}
                selected={mod === selectedMod}
                onSelect={() => handleSelectMod(mod)}
              />
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

      <div className="flex flex-col">
    <label className="mb-1">Launch Arguments</label>
    <input
        type="text"
        name="launch_args_input"
        placeholder="-debug"
        value={settings.launch_args?.join(" ") || ""}
        onChange={(e) => setSettings(prev => ({
            ...prev,
            launch_args: e.target.value.split(" ").filter(a => a.length > 0)
        }))}
        className="input input-bordered input-sm"
    />
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