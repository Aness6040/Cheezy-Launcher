import React, { useState, useEffect } from "react";
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
  setSelectedMod(prev => prev === modName ? null : modName);
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
      const exeDir = await invoke("get_main_dir", { folderName: "" });
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

function CatDropdown({ categories, selectedCat, onSelect }) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef(null);

  const selected = categories.find(c => c._idRow === selectedCat) || categories[0];

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="btn btn-sm btn-outline flex items-center gap-2 min-w-32"
      >
        {selected?._sIconUrl && (
          <img src={selected._sIconUrl} alt="" className="w-4 h-4 object-contain" />
        )}
        <span className="truncate max-w-24">{selected?._sName || "All"}</span>
        <span className="ml-auto">▾</span>
      </button>
      {open && (
        <div className="absolute top-full mt-1 left-0 z-50 bg-base-100 border border-base-300 rounded shadow-lg max-h-64 overflow-y-auto min-w-48">
          {categories.map((cat) => (
            <button
              key={cat._idRow}
              onClick={() => { onSelect(cat._idRow); setOpen(false); }}
              className={`flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-base-200 text-left
                ${selectedCat === cat._idRow ? "bg-primary/20 text-primary" : ""}`}
            >
              {cat._sIconUrl
                ? <img src={cat._sIconUrl} alt="" className="w-5 h-5 object-contain flex-shrink-0" />
                : <span className="w-5 h-5 flex-shrink-0" />
              }
              {cat._sName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function BrowseMods({ modsDir, addLog }) {
  const [mods, setMods] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [downloading, setDownloading] = useState(null);
  const [categories, setCategories] = useState([]);
  const [selectedCat, setSelectedCat] = useState(null);

  const GAME_ID = 7692;
  const PER_PAGE = 15;

  useEffect(() => {
    const fetchCats = async () => {
      try {
        const res = await fetch(
          `https://gamebanana.com/apiv6/ModCategory/ByGame?_aGameRowIds[]=${GAME_ID}&_csvProperties=_sName,_idRow,_sIconUrl,_idParentCategoryRow&_nPerpage=50`
        );
        const data = await res.json();
        const roots = data.filter(c => c._idParentCategoryRow === 0);
        setCategories([{ _idRow: null, _sName: "All", _sIconUrl: null }, ...roots]);
      } catch (e) {
        addLog(`Error fetching categories: ${e}`);
      }
    };
    fetchCats();
  }, []);

  const fetchMods = async (search = "", p = 1, catId = selectedCat) => {
  setLoading(true);
  try {
    if (search) {
      let url = `https://gamebanana.com/apiv6/Mod/ByName?_sName=*${encodeURIComponent(search)}*&_idGameRow=${GAME_ID}`;
      url += `&_csvProperties=_sName,_sProfileUrl,_aSubmitter,_tsDateUpdated,_aPreviewMedia,_sDescription,_aRootCategory,_aFiles` +
             `&_nPerpage=${PER_PAGE}&_nPage=${p}&_sOrderBy=_tsDateUpdated,DESC`;

      const countUrl = `https://gamebanana.com/apiv11/Mod/Index?_nPage=1&_nPerpage=1&_aFilters%5BGeneric_Game%5D=${GAME_ID}&_sName=${encodeURIComponent(search)}`;

      const [res, countRes] = await Promise.all([fetch(url), fetch(countUrl)]);
      const records = await res.json();
      const countData = await countRes.json();

      setTotalCount(Math.ceil((countData._aMetadata?._nRecordCount || 0) / PER_PAGE));
      setMods((records || []).map((mod) => ({
        _idRow: mod._sProfileUrl?.split("/").pop(),
        name: mod._sName,
        owner: mod._aSubmitter?._sName,
        avi: mod._aSubmitter?._sAvatarUrl,
        upic: mod._aSubmitter?._sUpicUrl,
        preview: Array.isArray(mod._aPreviewMedia) && mod._aPreviewMedia[0]
          ? `${mod._aPreviewMedia[0]._sBaseUrl}/${mod._aPreviewMedia[0]._sFile220 ?? mod._aPreviewMedia[0]._sFile}`
          : null,
        cat: mod._aRootCategory?._sName,
        caticon: mod._aRootCategory?._sIconUrl,
        url: mod._sProfileUrl,
        lastupdate: mod._tsDateUpdated,
        files: mod._aFiles || {},
        description: mod._sDescription || "",
      })));
    } else {
      let url = catId
        ? `https://gamebanana.com/apiv11/Mod/Index?_nPage=${p}&_nPerpage=${PER_PAGE}&_aFilters%5BGeneric_Game%5D=${GAME_ID}&_aFilters%5BGeneric_Category%5D=${catId}`
        : `https://gamebanana.com/apiv11/Mod/Index?_nPage=${p}&_nPerpage=${PER_PAGE}&_aFilters%5BGeneric_Game%5D=${GAME_ID}`;

      const res = await fetch(url);
      const data = await res.json();

      setTotalCount(Math.ceil((data._aMetadata?._nRecordCount || 0) / PER_PAGE));
      setMods((data._aRecords || []).map((mod) => ({
        _idRow: mod._idRow,
        name: mod._sName,
        owner: mod._aSubmitter?._sName,
        avi: mod._aSubmitter?._sAvatarUrl,
        upic: mod._aSubmitter?._sUpicUrl,
        preview: mod._aPreviewMedia?._aImages?.[0]
          ? `${mod._aPreviewMedia._aImages[0]._sBaseUrl}/${mod._aPreviewMedia._aImages[0]._sFile220 ?? mod._aPreviewMedia._aImages[0]._sFile}`
          : null,
        cat: mod._aRootCategory?._sName,
        caticon: mod._aRootCategory?._sIconUrl,
        url: mod._sProfileUrl,
        lastupdate: mod._tsDateModified,
        files: {},
        description: "",
      })));
    }
  } catch (e) {
    addLog(`Error fetching mods: ${e}`);
  } finally {
    setLoading(false);
  }
};

  useEffect(() => { fetchMods(searchTerm, page); }, [page]);

  const handleSearch = () => { setPage(1); fetchMods(searchTerm, 1); };

  const handleCatSelect = (catId) => {
    setSelectedCat(catId);
    setPage(1);
    setSearchTerm("");
    fetchMods("", 1, catId);
  };

  const handleDownload = async (mod) => {
    setDownloading(mod._idRow);
    try {
      const res = await fetch(
        `https://api.gamebanana.com/Core/Item/Data?itemtype=Mod&itemid=${mod._idRow}&fields=Files().aFiles(),description&format=json`
      );
      const data = await res.json();
      const files = data[0] || {};
      const description = data[1] || "";

      if (!files || Object.keys(files).length === 0) {
        addLog(`No files for ${mod.name}`);
        return;
      }

      const file = Object.values(files)[0];
      addLog(`Downloading ${file._sFile}...`);

      const bytes = await invoke("fetch_file", { url: file._sDownloadUrl });
      await invoke("download_mod", {
        modName: mod.name,
        modsPath: modsDir,
        fileBytes: bytes,
        fileName: file._sFile,
      });

      const modJson = {
        title: mod.name,
        preview: mod.preview || "",
        submitter: mod.owner,
        avi: mod.avi,
        upic: mod.upic,
        caticon: mod.caticon,
        cat: mod.cat,
        description: description,
        filedescription: file._sDescription || "",
        homepage: mod.url,
        lastupdate: new Date(mod.lastupdate * 1000).toISOString(),
      };

      await invoke("edit_item", {
        path: `${modsDir}\\${mod.name}\\mod.json`,
        content: JSON.stringify(modJson, null, 2),
      });

      addLog(`✓ Downloaded: ${mod.name}`);
    } catch (e) {
      addLog(`Error downloading ${mod.name}: ${e}`);
    } finally {
      setDownloading(null);
    }
  };

  const totalPages = totalCount;

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Search bar */}
      <div className="flex gap-2 flex-shrink-0">
  <input
    type="text"
    placeholder="Search mods on GameBanana..."
    value={searchTerm}
    onChange={(e) => setSearchTerm(e.target.value)}
    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
    className="input input-bordered input-sm flex-1"
  />
  <CatDropdown
    categories={categories}
    selectedCat={selectedCat}
    onSelect={handleCatSelect}
  />
  <button onClick={handleSearch} className="btn btn-sm btn-primary">
    Search
  </button>
</div>

      {/* Mod list */}
      <div className="flex-1 overflow-auto">
        {loading && <p className="text-sm">Loading...</p>}
        {!loading && mods.length === 0 && <p className="text-sm">No mods found.</p>}
        {!loading && mods.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {mods.map((mod) => (
              <div
                key={mod._idRow}
                className="rounded border border-base-300 shadow-md overflow-hidden flex flex-col"
              >
                {mod.preview && (
                  <img
                    src={mod.preview}
                    alt={mod.name}
                    className="w-full h-32 object-cover"
                    onError={(e) => e.target.style.display = "none"}
                  />
                )}
                <div className="p-3 flex flex-col gap-1 flex-1">
                  <h2 className="text-sm font-bold truncate">{mod.name}</h2>
                  <p className="text-xs text-gray-400 truncate">{mod.owner} • {mod.cat}</p>
                  <div className="mt-auto flex gap-2 pt-2">
                    
                    <a  href={mod.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-xs btn-outline flex-1"
                    >
                      View
                    </a>
                    <button
                      onClick={() => handleDownload(mod)}
                      disabled={downloading === mod._idRow}
                      className="btn btn-xs btn-primary flex-1"
                    >
                      {downloading === mod._idRow ? "..." : "Install"}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="join flex justify-center flex-shrink-0">
          <button
            className="join-item btn"
            disabled={page === 1}
            onClick={() => setPage(p => p - 1)}
          >
            ←
          </button>
          <span className="join-item btn btn-active">Page {page} / {totalPages}</span>
          <button
            className="join-item btn"
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
          >
            →
          </button>
        </div>
      )}
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
    e.preventDefault();
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
      <a role="tab" className={`tab ${activeTab === "tab1" ? "tab-active" : ""}`} onClick={() => setActiveTab("tab1")}>Manage Mods</a>
      <a role="tab" className={`tab ${activeTab === "tab2" ? "tab-active" : ""}`} onClick={() => setActiveTab("tab2")}>GMLoader Mods</a>
      <a role="tab" className={`tab ${activeTab === "tab3" ? "tab-active" : ""}`} onClick={() => setActiveTab("tab3")}>Browse Mods</a>
    </div>
    <a role="tab" className={`tab ${activeTab === "settings" ? "tab-active" : ""}`} onClick={() => setActiveTab("settings")}>Settings</a>
  </div>
  <div className="flex-1 p-4 bg-base-200 rounded-lg">
    
    <div className="flex-1 overflow-auto" style={{ height: `calc(100vh - ${(activeTab === "tab1" || activeTab === "tab2") ? "270px" : "90px"})` }}>
      {activeTab === "tab1" && <Tab1 modsDir={modsDir} overwiteDir={overwiteDir} addLog={addLog} logs={logs} />}
      {activeTab === "tab2" && <p>2nd (will be GMLoader suuport)</p>}
      {activeTab === "tab3" && <BrowseMods modsDir={modsDir} addLog={addLog} />}
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