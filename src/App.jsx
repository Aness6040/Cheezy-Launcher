import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";
import AnsiToHtml from "ansi-to-html";
import chalk from 'chalk';
import { openUrl } from "@tauri-apps/plugin-opener";

import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";

import { onOpenUrl } from '@tauri-apps/plugin-deep-link';

await onOpenUrl((urls) => {
  console.log('deep link:', urls);
});

const themes = [
  "light",
  "dark"
];

function ModCard({ modPath, modName, selected = false, onSelect, contextMenu, setContextMenu }) {
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

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, []);

  const handleContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu(prev =>
        prev?.modName === modName ? null : { x: e.clientX, y: e.clientY, modName, modPath, modData }
    );
};

  const handleOpenFolder = (e) => {
    e.stopPropagation();
    invoke("open_item", { path: modPath.replace(/\//g, "\\") });
    setContextMenu(null);
};

  const handleViewPage = (e) => {
    e.stopPropagation();
    if (modData?.homepage) {
        openUrl(modData.homepage);
    }
    setContextMenu(null);
  };

  const handleDelete = async (e) => {
    e.stopPropagation();
    setContextMenu(null);
    const confirmed = await window.confirm(`Delete "${modData?.title || modName}"?`);
    if (confirmed) {
      await invoke("remove_item", { path: modPath });
    }
  };

  const title = modData?.title || modName;
  const preview = modData?.preview || null;
  const submitter = modData?.submitter || "Unknown";
  const cat = modData?.cat || "Unknown";
  const description = modData?.description || "";

  return (
    <>
      <div
        className={`rounded border transition-colors shadow-md overflow-hidden cursor-pointer
                    ${selected ? "border-primary bg-primary/20" : "border-base-300 hover:border-primary"}`}
        onClick={onSelect}
        onContextMenu={handleContextMenu}
      >
        {preview && (
          <img src={preview} alt={title} className="w-full h-32 object-cover" />
        )}
        <div className="card-body flex flex-col justify-center items-center p-4 text-center">
          <h2 className="card-title text-sm font-bold truncate">{title}</h2>
          <p className="text-xs text-gray-400 truncate">{submitter} • {cat}</p>
          {description && <p className="text-xs mt-1 line-clamp-2">{description}</p>}
          {modData?.homepage && (
            
            <a  href={modData.homepage}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 text-xs mt-1 hover:underline"
            >
              {modData.homepage}
            </a>
          )}
        </div>
      </div>
    </>
  );
}

function Tab1({ modsDir, overwiteDir, addLog, logs}) {
  const [mods, setMods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedMod, setSelectedMod] = useState(null);
  const [operationRunning, setOperationRunning] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);

  const fetchMods = () => {
    if (!modsDir) return;
    invoke("list_mods", { modsPath: modsDir })
      .then((folders) => setMods(folders))
      .catch((e) => { console.error(e); addLog(`Error loading mods`); })
      .finally(() => setLoading(false));
  };

  const filteredMods = mods.filter(mod =>
    mod.toLowerCase().includes(searchTerm.toLowerCase())
  );

  useEffect(() => {
    const unlisten = listen("prepare-log", (event) => { addLog(event.payload); });
    return () => { unlisten.then(f => f()); };
  }, []);

  useEffect(() => {
    fetchMods();
    const interval = setInterval(fetchMods, 2000);
    return () => clearInterval(interval);
  }, [modsDir]);

  const handleRunFile = async (mode = "full") => {
    if (operationRunning) return;

    setOperationRunning(true);
    addLog(chalk.yellow("Preparing overwrite..."));

    try {
      const vfsRoot = await invoke("get_main_dir", { folderName: "vfs_root" });
      const settingsData = await invoke("get_settings");
      const gmlDir = modsDir.replace(/[/\\]mods$/, "\\mods_GML");
      if (mode !== "launch") {
      await invoke("prepare_overwrite", {
        mods: selectedMod ? [selectedMod] : [],
        modsPath: modsDir,
        overwritePath: overwiteDir,
        gameDir: settingsData.game_dir,
        prepatch: settingsData.prepatch || "",
        gmloaderEnabled: gmloaderEnabled,
        gmlModsPath: gmlDir,
      });
      }
      if (mode === "over") setOperationRunning(false);
      if (mode !== "over") {
      addLog(chalk.yellow("Mounting VFS..."));

      await invoke("mount_vfs", {
        gameDir: settingsData.game_dir,
        overwritePath: overwiteDir,
        vfsRoot,
        steamApi: settingsData.steam_api || false,
        gmloaderEnabled: gmloaderEnabled,
      });
      if (gmloaderEnabled) {
  await invoke("launch_game", {
    vfsRoot,
    exeName: "GMLoader.exe",
    launchArgs: [],
  });

  addLog(chalk.green("Executing GMLoader process..."));

  const waitGmloader = setInterval(async () => {
    const running = await invoke("is_operation_running");

    if (!running) {
      clearInterval(waitGmloader);

      addLog(chalk.yellow("GMLoader Process finished, launching Pizza Tower..."));
      await invoke("kill_process", { name: "PizzaTower.exe" });
      launchPizzaTower();
    }
  }, 100);

} else {
  addLog(chalk.yellow("Launching Pizza Tower..."));
  launchPizzaTower();
}
      }


async function launchPizzaTower() {
  await invoke("launch_game", {
    vfsRoot,
    exeName: "PizzaTower.exe",
    launchArgs: settingsData.launch_args || [],
  });

  addLog(chalk.green("Game is running"));

  const poll = setInterval(async () => {
    const runningGame = await invoke("is_operation_running");

    if (!runningGame) {
      clearInterval(poll);

      addLog(chalk.yellow("Game closed, unmounting VFS..."));
      await invoke("unmount_vfs", { vfsRoot });

      addLog(chalk.green("VFS unmounted"));
      setOperationRunning(false);
    }
  }, 2000);
}

    } catch (e) {
      addLog(chalk.red(`Error: ${e}`));
      setOperationRunning(false);
    }
  };

  const handleSelectMod = (modName) => {
    setSelectedMod(prev => prev === modName ? null : modName);
  };

  const [gmloaderEnabled, setGmloaderEnabled] = useState(false);

  const useMods = selectedMod || gmloaderEnabled

useEffect(() => {
    invoke("get_settings").then(s => setGmloaderEnabled(s.gmloader_enabled || false));
}, []);

const handleToggleGML = async (e) => {
    const val = e.target.checked;
    setGmloaderEnabled(val);
    const exeDir = await invoke("get_main_dir", { folderName: "" });
    const settings = await invoke("get_settings");
    await invoke("edit_item", {
        path: `${exeDir}\\settings.json`,
        content: JSON.stringify({ ...settings, gmloader_enabled: val }, null, 2),
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
        <button className="btn btn-sm btn-primary" onClick={() => setSearchTerm("")}>Clear</button>
      </div>

      <div className="flex gap-3 mb-3 flex-shrink-0 items-center">
    <div className={`join ${operationRunning ? "opacity-50 pointer-events-none" : ""}`}>
  <button
    onClick={handleRunFile}
    disabled={operationRunning}
    className="btn btn-primary join-item"
  >
    {operationRunning ? "Running..." : "Launch"}
  </button>
  <div className="dropdown dropdown-bottom dropdown-center">
    <button tabIndex={0} className="btn btn-primary join-item px-2" disabled={operationRunning}>▾</button>
    <ul tabIndex={0} className="dropdown-content menu bg-base-100 rounded-box shadow-lg z-50 w-40 mt-1">
      <li className={!useMods ? "opacity-50 pointer-events-none" : ""}><a onClick={() => { if (!useMods) return; document.activeElement.blur(); handleRunFile("over"); }}>Overwrite Only</a></li>
      <li><a onClick={() => { document.activeElement.blur(); handleRunFile("launch"); }}>Launch Only</a></li>
    </ul>
  </div>
</div>
    <label className="flex items-center gap-2 cursor-pointer">
        <span className="text-sm">GMLoader</span>
        <input
            type="checkbox"
            className="toggle toggle-primary toggle-sm"
            checked={gmloaderEnabled}
            onChange={handleToggleGML}
        />
    </label>
</div>

      <div className="flex-1 overflow-auto">
        {loading && <p className="text-sm">Loading...</p>}
        {!loading && mods.length === 0 && <p className="text-sm">No mods found in {modsDir}</p>}
        {!loading && mods.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {filteredMods.map((mod) => (
              <ModCard
                key={mod}
                modName={mod}
                modPath={`${modsDir}/${mod}`}
                selected={mod === selectedMod}
                onSelect={() => handleSelectMod(mod)}
                setContextMenu={setContextMenu}
              />
            ))}
          </div>
        )}
      </div>
      {contextMenu && (
    <ul
        className="menu bg-base-100 rounded-box w-56 fixed z-50 shadow-lg"
        style={{
            top: Math.min(contextMenu.y, window.innerHeight - 150),
            left: Math.min(contextMenu.x, window.innerWidth - 224),
        }}
        onClick={(e) => e.stopPropagation()}
    >
        <li>
            <a onClick={() => { invoke("open_item", { path: contextMenu.modPath.replace(/\//g, "\\") }); setContextMenu(null); }}>
                Open Folder
            </a>
        </li>
        {contextMenu.modData?.homepage && (
            <li>
                <a onClick={() => { openUrl(contextMenu.modData.homepage); setContextMenu(null); }}>
                    View Page
                </a>
            </li>
        )}
        <li>
            
             <a className="text-error"
                onClick={async () => {
                    setContextMenu(null);
                    const confirmed = await window.confirm(`Delete "${contextMenu.modData?.title || contextMenu.modName}"?`);
                    if (confirmed) await invoke("remove_item", { path: contextMenu.modPath.replace(/\//g, "\\") });
                }}
            >
                Delete
            </a>
        </li>
    </ul>
)}
    </div>
  );
}

function SortableGMLItem({ id, index, enabled, onToggle, selected, selectMode, onClick, setContextMenu, searchActive }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: searchActive });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };

  const handleContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu(prev =>
      prev?.modName === id ? null : { x: e.clientX, y: e.clientY, modName: id }
    );
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onClick}
      onContextMenu={handleContextMenu}
      className={`flex items-center gap-3 p-3 rounded border transition-colors cursor-pointer
        ${isDragging ? "border-primary bg-primary/10"
          : selected ? "border-primary bg-primary/20"
          : enabled ? "border-base-300 bg-base-100 hover:border-primary"
          : "border-base-300 bg-base-200 opacity-60"}`}
    >
      {!searchActive && (<span className="text-base-content/40 cursor-grab" {...attributes} {...listeners} onClick={e => e.stopPropagation()}>☰</span>)}
      <span className={`text-sm font-medium flex-1 select-none ${!enabled ? "text-base-content/40" : ""}`}>{id}</span>
      <span className="text-xs text-base-content/40 select-none">#{index + 1}</span>
      <input
        type="checkbox"
        className="checkbox checkbox-sm checkbox-primary"
        checked={enabled}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}


function Tab2({ modsDir, addLog }) {
  const [mods, setMods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [contextMenu, setContextMenu] = useState(null);
  const [selected, setSelected] = useState([]);
  const [selectMode, setSelectMode] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const isDragging = useRef(false);

  const gmlDir = modsDir?.replace(/[/\\]mods$/, "\\mods_GML");
  const modsJsonPath = `${gmlDir}\\mods.json`;

  const fetchMods = async () => {
    if (!gmlDir || isDragging.current) return;
    try {
      const folders = await invoke("list_mods", { modsPath: gmlDir });
      let savedOrder = [];
      try {
        const content = await invoke("read_item", { path: modsJsonPath });
        savedOrder = JSON.parse(content);
      } catch (e) {}

      const savedNames = savedOrder.map(([name]) => name);
      const newMods = folders.filter(f => !savedNames.includes(f));
      const ordered = [
        ...savedOrder.filter(([name]) => folders.includes(name)),
        ...newMods.map(name => [name, true]),
      ];

      if (newMods.length > 0 || savedOrder.length !== ordered.length) {
        await invoke("edit_item", {
          path: modsJsonPath,
          content: JSON.stringify(ordered, null, 2),
        });
      }

      setMods(ordered);
    } catch (e) {
      addLog("Error loading GML mods");
    } finally {
      setLoading(false);
    }
  };

  const saveMods = async (newMods) => {
    try {
      await invoke("edit_item", {
        path: modsJsonPath,
        content: JSON.stringify(newMods, null, 2),
      });
    } catch (e) {
      addLog(`Error saving mods.json: ${e}`);
    }
  };

  useEffect(() => {
    fetchMods();
    const interval = setInterval(fetchMods, 2000);
    return () => clearInterval(interval);
  }, [gmlDir]);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, []);

  const handleDragStart = () => { isDragging.current = true; };

  const handleDragEnd = (event) => {
    isDragging.current = false;
    const { active, over } = event;
    if (active.id !== over?.id) {
      setMods(prev => {
        const oldIndex = prev.findIndex(([name]) => name === active.id);
        const newIndex = prev.findIndex(([name]) => name === over.id);
        const newMods = arrayMove(prev, oldIndex, newIndex);
        saveMods(newMods);
        return newMods;
      });
    }
  };

  const handleToggle = (name) => {
    setMods(prev => {
      const newMods = prev.map(([n, enabled]) =>
        n === name ? [n, !enabled] : [n, enabled]
      );
      saveMods(newMods);
      return newMods;
    });
  };

  const handleItemClick = (name, e) => {
    if (selectMode) {
      setSelected(prev =>
        prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
      );
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setSelected(prev =>
        prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
      );
    } else if (e.shiftKey && selected.length > 0) {
      const names = mods.map(([n]) => n);
      const lastSelected = selected[selected.length - 1];
      const lastIndex = names.indexOf(lastSelected);
      const currentIndex = names.indexOf(name);
      const [start, end] = [Math.min(lastIndex, currentIndex), Math.max(lastIndex, currentIndex)];
      const range = names.slice(start, end + 1);
      setSelected(prev => [...new Set([...prev, ...range])]);
    } else {
      setSelected(prev => prev.includes(name) && prev.length === 1 ? [] : [name]);
    }
  };

  const handleSelectAll = () => {
    if (selected.length === mods.length) setSelected([]);
    else setSelected(mods.map(([name]) => name));
  };

  const handleSetTopPriority = (targets) => {
    setMods(prev => {
      const top = prev.filter(([name]) => targets.includes(name));
      const rest = prev.filter(([name]) => !targets.includes(name));
      const newMods = [...top, ...rest];
      saveMods(newMods);
      return newMods;
    });
    setContextMenu(null);
    setSelected([]);
  };

  const handleSetBottomPriority = (targets) => {
    setMods(prev => {
      const bottom = prev.filter(([name]) => targets.includes(name));
      const rest = prev.filter(([name]) => !targets.includes(name));
      const newMods = [...rest, ...bottom];
      saveMods(newMods);
      return newMods;
    });
    setContextMenu(null);
    setSelected([]);
  };

  const handleToggleSelected = (targets, enable) => {
    setMods(prev => {
      const newMods = prev.map(([name, enabled]) =>
        targets.includes(name) ? [name, enable] : [name, enabled]
      );
      saveMods(newMods);
      return newMods;
    });
    setContextMenu(null);
    setSelected([]);
  };

  const handleDeleteSelected = async (targets) => {
    setContextMenu(null);
    const confirmed = await window.confirm(`Delete ${targets.length} mod(s)?`);
    if (!confirmed) return;
    for (const name of targets) {
      await invoke("remove_item", { path: `${gmlDir}\\${name}` });
    }
    setSelected([]);
    fetchMods();
  };

  const handleOpenFolder = (name) => {
    invoke("open_item", { path: `${gmlDir}\\${name}` });
    setContextMenu(null);
  };

  const getTargets = (modName) => {
    if (selected.includes(modName) && selected.length > 0) return selected;
    return [modName];
  };

  const filteredMods = mods
    .map(([name, enabled], index) => ({ name, enabled, index }))
    .filter(({ name }) => name.toLowerCase().includes(searchTerm.toLowerCase()));

  return (
    <div className="flex flex-col h-full gap-3">
      <div className="flex items-center justify-between flex-shrink-0 gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">GMLoader Mods</p>
          {selected.length > 0 && (
            <span className="badge badge-primary badge-sm">{selected.length} selected</span>
          )}
        </div>
        <div className="flex gap-2 flex-wrap justify-end items-center">
          <input
            type="text"
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="input input-bordered input-sm w-32"
          />
          {selected.length > 0 && (
            <>
              <button onClick={() => handleSetTopPriority(selected)} className="btn btn-xs btn-outline">↑ Top</button>
              <button onClick={() => handleSetBottomPriority(selected)} className="btn btn-xs btn-outline">↓ Bottom</button>
              <button onClick={() => handleToggleSelected(selected, true)} className="btn btn-xs btn-outline">Enable</button>
              <button onClick={() => handleToggleSelected(selected, false)} className="btn btn-xs btn-outline">Disable</button>
              <button onClick={() => handleDeleteSelected(selected)} className="btn btn-xs btn-error">Delete</button>
            </>
          )}
          <button
            onClick={() => { setSelectMode(p => !p); setSelected([]); }}
            className={`btn btn-xs ${selectMode ? "btn-primary" : "btn-outline"}`}
          >
            {selectMode ? "✓ Select" : "Select"}
          </button>
          <button onClick={handleSelectAll} className="btn btn-xs btn-outline">
            {selected.length === mods.length && mods.length > 0 ? "Deselect All" : "Select All"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {loading && <p className="text-sm">Loading...</p>}
        {!loading && mods.length === 0 && <p className="text-sm">No GMLoader mods found in {gmlDir}</p>}
        {!loading && mods.length > 0 && (
          <DndContext
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          >
            <SortableContext
              items={filteredMods.map(({ name }) => name)}
              strategy={verticalListSortingStrategy}
            >
              <div className="flex flex-col gap-2">
                {filteredMods.map(({ name, enabled, index }) => (
                  <SortableGMLItem
                    key={name}
                    id={name}
                    index={index}
                    enabled={enabled}
                    selected={selected.includes(name)}
                    selectMode={selectMode}
                    onToggle={() => handleToggle(name)}
                    onClick={(e) => handleItemClick(name, e)}
                    setContextMenu={setContextMenu}
                    searchActive={!!searchTerm}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {contextMenu && (
        <ul
          className="menu bg-base-100 rounded-box w-56 fixed z-50 shadow-lg"
          style={{
            top: Math.min(contextMenu.y, window.innerHeight - 220),
            left: Math.min(contextMenu.x, window.innerWidth - 224),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <li><a onClick={() => handleOpenFolder(contextMenu.modName)}>Open Folder</a></li>
          <li><a onClick={() => handleSetTopPriority(getTargets(contextMenu.modName))}>Set Top Priority</a></li>
          <li><a onClick={() => handleSetBottomPriority(getTargets(contextMenu.modName))}>Set Bottom Priority</a></li>
          <li><a onClick={() => handleToggleSelected(getTargets(contextMenu.modName), true)}>Enable</a></li>
          <li><a onClick={() => handleToggleSelected(getTargets(contextMenu.modName), false)}>Disable</a></li>
          <div className="divider my-0"/>
          <li><a className="text-error" onClick={() => handleDeleteSelected(getTargets(contextMenu.modName))}>🗑️ Delete</a></li>
        </ul>
      )}
    </div>
  );
}

function SettingsTab({ onSave }) {
  const [settings, setSettings] = useState({ theme: "", launch_args: [], game_dir: "", game_data_dir: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [prepatches, setPrepatches] = useState([]);

  useEffect(() => {
    invoke("get_settings")
      .then((data) => { setSettings(data); applyTheme(data.theme); })
      .catch(console.error)
      .finally(() => setLoading(false));
    invoke("list_prepatches").then(setPrepatches).catch(console.error);
  }, []);

  const applyTheme = (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setSettings(prev => ({ ...prev, [name]: value }));
    if (name === "theme") applyTheme(value);
  };

  const handleBrowse = async (field) => {
    try {
        const path = await open({ directory: true, multiple: false, defaultPath: settings[field] || undefined, });
        if (path) setSettings(prev => ({ ...prev, [field]: path }));
    } catch (e) {}
};

  const handleDetect = async (field) => {
    try {
      const cmd = field === "game_dir" ? "detect_game_dir" : "detect_game_data_dir";
      const path = await invoke(cmd);
      setSettings(prev => ({ ...prev, [field]: path }));
    } catch (e) {
      alert(`Could not detect automatically: ${e}`);
    }
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
      onSave(settings);
      alert("Settings saved!");
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
        <label className="mb-1 text-sm font-semibold">Theme</label>
        <select name="theme" value={settings.theme} onChange={handleChange} className="select select-bordered select-sm">
          {themes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <div className="flex items-center gap-2">
      <label className="text-sm font-semibold">Enable Steam API</label>
      <input
        type="checkbox"
        className="toggle toggle-primary"
        checked={settings.steam_api || false}
        onChange={(e) => setSettings(prev => ({ ...prev, steam_api: e.target.checked }))}
      />
      </div>

      <div className="flex flex-col">
        <label className="mb-1 text-sm font-semibold">Launch Arguments</label>
        <input
          type="text"
          placeholder="-debug"
          value={settings.launch_args?.join(" ") || ""}
          onChange={(e) => setSettings(prev => ({
            ...prev,
            launch_args: e.target.value.split(" ").filter(a => a.length > 0)
          }))}
          className="input input-bordered input-sm"
        />
      </div>

      <div className="flex flex-col">
        <label className="mb-1 text-sm font-semibold">Game Directory</label>
        <div className="flex gap-2">
          <input
            type="text"
            name="game_dir"
            value={settings.game_dir || ""}
            onChange={handleChange}
            placeholder="C:\..."
            className="input input-bordered input-sm flex-1"
          />
          <button onClick={() => handleBrowse("game_dir")} className="btn btn-sm btn-outline">Browse</button>
          <button onClick={() => handleDetect("game_dir")} className="btn btn-sm btn-outline">Reset</button>
        </div>
      </div>

      <div className="flex flex-col">
        <label className="mb-1 text-sm font-semibold">Game Data Directory (AppData)</label>
        <div className="flex gap-2">
          <input
            type="text"
            name="game_data_dir"
            value={settings.game_data_dir || ""}
            onChange={handleChange}
            placeholder="%APPDATA%\Pizza Tower"
            className="input input-bordered input-sm flex-1"
          />
          <button onClick={() => handleBrowse("game_data_dir")} className="btn btn-sm btn-outline">Browse</button>
          <button onClick={() => handleDetect("game_data_dir")} className="btn btn-sm btn-outline">Reset</button>
        </div>
      </div>

      <div className="flex flex-col">
    <label className="mb-1 text-sm font-semibold">Prepatch (Downgrade)</label>
    <select
        name="prepatch"
        value={settings.prepatch || ""}
        onChange={handleChange}
        className="select select-bordered select-sm"
    >
        <option value="">None</option>
        {prepatches.map(p => (
            <option key={p} value={p}>{p}</option>
        ))}
    </select>
  </div>

      <button onClick={handleSave} disabled={saving} className="btn btn-primary w-max">
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
  const [filePickerMod, setFilePickerMod] = useState(null);

  const [sortBy, setSortBy] = useState("_tsDateUpdated,DESC");

  const GAME_ID = 7692;
  const PER_PAGE = 15;
  const CYOP_IDS = [25679, 22962, 25680];
  const GMLOADER_ID = 36921;

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

  // Normalise un mod v6 + v11 en objet unifié
  const normalizeMod = (modV6, modV11 = {}) => {
    const id = modV6._idRow || modV6._sProfileUrl?.split("/").pop();
    return {
      _idRow: id,
      name: modV6._sName,
      owner: modV6._aSubmitter?._sName,
      avi: modV6._aSubmitter?._sAvatarUrl,
      upic: modV6._aSubmitter?._sUpicUrl,
      preview: modV11._aPreviewMedia?._aImages?.[0]
        ? `${modV11._aPreviewMedia._aImages[0]._sBaseUrl}/${modV11._aPreviewMedia._aImages[0]._sFile220 ?? modV11._aPreviewMedia._aImages[0]._sFile}`
        : Array.isArray(modV6._aPreviewMedia) && modV6._aPreviewMedia[0]
          ? `${modV6._aPreviewMedia[0]._sBaseUrl}/${modV6._aPreviewMedia[0]._sFile220 ?? modV6._aPreviewMedia[0]._sFile}`
          : null,
      cat: modV6._aRootCategory?._sName,
      caticon: modV6._aRootCategory?._sIconUrl,
      catId: modV6._aRootCategory?._idRow,
      url: modV6._sProfileUrl || modV11._sProfileUrl,
      lastupdate: modV6._tsDateUpdated || modV11._tsDateModified,
      files: modV6._aFiles || {},
      description: modV6._sDescription || "",
    };
  };

  const fetchMods = async (search = "", p = 1, catId = selectedCat, sort = sortBy) => {
    setLoading(true);
    try {
        if (search) {
            let urlV6 = `https://gamebanana.com/apiv6/Mod/ByName?_sName=*${encodeURIComponent(search)}*&_idGameRow=${GAME_ID}`;
            urlV6 += `&_csvProperties=_sName,_idRow,_sProfileUrl,_aSubmitter,_tsDateUpdated,_aPreviewMedia,_sDescription,_aRootCategory,_aFiles`;
            urlV6 += `&_nPerpage=${PER_PAGE}&_nPage=${p}`;

            const countUrl = `https://gamebanana.com/apiv11/Mod/Index?_nPage=1&_nPerpage=1&_aFilters%5BGeneric_Game%5D=${GAME_ID}&_sName=${encodeURIComponent(search)}`;

            const [resV6, countRes] = await Promise.all([fetch(urlV6), fetch(countUrl)]);
            const recordsV6 = await resV6.json();
            const countData = await countRes.json();

            const ids = (recordsV6 || []).map(mod => mod._idRow || mod._sProfileUrl?.split("/").pop());
            const v11Map = {};
            if (ids.length > 0) {
                const v11Results = await Promise.all(
                    ids.map(id => fetch(`https://gamebanana.com/apiv11/Mod/${id}?_csvProperties=_aPreviewMedia,_sProfileUrl,_tsDateModified`).then(r => r.json()))
                );
                ids.forEach((id, i) => { v11Map[id] = v11Results[i]; });
            }

            setTotalCount(Math.ceil((countData._aMetadata?._nRecordCount || 0) / PER_PAGE));
            setMods((recordsV6 || []).map(mod => {
                const id = mod._idRow || mod._sProfileUrl?.split("/").pop();
                return normalizeMod(mod, v11Map[id] || {});
            }));

        } else if (catId) {
            const urlV11 = `https://gamebanana.com/apiv11/Mod/Index?_nPage=${p}&_nPerpage=${PER_PAGE}&_aFilters%5BGeneric_Game%5D=${GAME_ID}&_aFilters%5BGeneric_Category%5D=${catId}&_sOrderBy=${sort}`;
            const countUrl = `https://gamebanana.com/apiv11/Mod/Index?_nPage=1&_nPerpage=1&_aFilters%5BGeneric_Game%5D=${GAME_ID}&_aFilters%5BGeneric_Category%5D=${catId}`;

            const [resV11, countRes] = await Promise.all([fetch(urlV11), fetch(countUrl)]);
            const recordsV11 = await resV11.json();
            const countData = await countRes.json();

            setTotalCount(Math.ceil((countData._aMetadata?._nRecordCount || 0) / PER_PAGE));
            setMods((recordsV11._aRecords || []).map(mod => normalizeMod(mod, mod)));

        } else {
            let urlV6 = `https://gamebanana.com/apiv6/Mod/ByGame?_aGameRowIds[]=${GAME_ID}`;
            urlV6 += `&_csvProperties=_sName,_idRow,_sProfileUrl,_aSubmitter,_tsDateUpdated,_aPreviewMedia,_aRootCategory`;
            urlV6 += `&_nPerpage=${PER_PAGE}&_nPage=${p}&_sOrderBy=${sort}`;

            const urlV11 = `https://gamebanana.com/apiv11/Mod/Index?_nPage=${p}&_nPerpage=${PER_PAGE}&_aFilters%5BGeneric_Game%5D=${GAME_ID}`;
            const countUrl = `https://gamebanana.com/apiv11/Mod/Index?_nPage=1&_nPerpage=1&_aFilters%5BGeneric_Game%5D=${GAME_ID}`;

            const [resV6, resV11, countRes] = await Promise.all([fetch(urlV6), fetch(urlV11), fetch(countUrl)]);
            const recordsV6 = await resV6.json();
            const recordsV11 = await resV11.json();
            const countData = await countRes.json();

            const v11Map = {};
            for (const mod of (recordsV11._aRecords || [])) { v11Map[mod._idRow] = mod; }

            setTotalCount(Math.ceil((countData._aMetadata?._nRecordCount || 0) / PER_PAGE));
            setMods((recordsV6 || []).map(mod => {
                const id = mod._idRow || mod._sProfileUrl?.split("/").pop();
                return normalizeMod(mod, v11Map[id] || {});
            }));
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

  const handlePickFile = async (mod) => {
  try {
    const res = await fetch(
      `https://gamebanana.com/apiv11/Mod/${mod._idRow}?_csvProperties=_aFiles,_sDescription,_aRootCategory`
    );
    const data = await res.json();
    const files = data._aFiles || {};

    if (Object.keys(files).length === 0) {
      addLog(`No files for ${mod.name}`);
      return;
    }

    setFilePickerMod({
      mod,
      files: Object.values(files),
      description: data._sDescription || "",
      rootCatId: data._aRootCategory?._idRow,
      rootCatParentId: data._aRootCategory?._idParentCategoryRow,
    });
  } catch (e) {
    addLog(`Error fetching files: ${e}`);
  }
};

const handleDownload = async (file) => {
  const { mod, description, rootCatId, rootCatParentId } = filePickerMod;
  setFilePickerMod(null);

  if (!window.confirm(`Install "${mod.name}" — ${file._sFile}?`)) return;
  setDownloading(mod._idRow);

  try {
    const isCYOP = CYOP_IDS.includes(rootCatId) || CYOP_IDS.includes(rootCatParentId);
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

    addLog(`Downloading ${file._sFile}...`);
    const bytes = await invoke("fetch_file", { url: file._sDownloadUrl });
    await invoke("download_mod", {
      modName: mod.name,
      modsPath: targetModsPath,
      fileBytes: bytes,
      fileName: file._sFile,
    });

    if (isCYOP) await invoke("flatten_mod_dir", { modPath: `${targetModsPath}\\${mod.name}` });

    if (writeModJson) {
      const modJson = {
        title: mod.name,
        preview: mod.preview || "",
        submitter: mod.owner,
        avi: mod.avi,
        upic: mod.upic,
        caticon: mod.caticon,
        cat: mod.cat,
        description,
        filedescription: file._sDescription || "",
        homepage: mod.url,
        lastupdate: new Date(mod.lastupdate * 1000).toISOString(),
      };
      await invoke("edit_item", {
        path: `${targetModsPath}\\${mod.name}\\mod.json`,
        content: JSON.stringify(modJson, null, 2),
      });
    }

    addLog(`✓ Downloaded: ${mod.name}`);
    window.alert(`"${mod.name}" has been correctly installed!`);
  } catch (e) {
    addLog(`Error downloading ${mod.name}: ${e}`);
  } finally {
    setDownloading(null);
  }
};

  return (
    <>
    <div className="flex flex-col h-full gap-3">
      <div className="flex gap-2 flex-shrink-0">
        <input
          type="text"
          placeholder="Search mods on GameBanana..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          className="input input-bordered input-sm flex-1"
        />
        <CatDropdown categories={categories} selectedCat={selectedCat} onSelect={handleCatSelect} />
        <select
          value={sortBy}
          disabled={!!searchTerm || selectedCat}
          onChange={(e) => { setSortBy(e.target.value); setPage(1); fetchMods("", 1, selectedCat, e.target.value); }}
          className="select select-bordered select-sm w-auto disabled:opacity-50"
        >
          <option value="_tsDateUpdated,DESC">Latest</option>
          <option value="_nDownloadCount,DESC">Most Downloaded</option>
          <option value="_nLikeCount,DESC">Most Liked</option>
          <option value="_bIsFeatured,DESC">Featured</option>
          <option value="_tsDateUpdated,ASC">Oldest</option>
        </select>
        <button onClick={handleSearch} className="btn btn-sm btn-primary">Search</button>
      </div>

      <div className="flex-1 overflow-auto">
        {loading && <p className="text-sm">Loading...</p>}
        {!loading && mods.length === 0 && <p className="text-sm">No mods found.</p>}
        {!loading && mods.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {mods.map((mod) => (
              <div key={mod._idRow} className="rounded border border-base-300 shadow-md overflow-hidden flex flex-col">
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
                    <a href={mod.url} target="_blank" rel="noopener noreferrer" className="btn btn-xs btn-outline flex-1">View</a>
                    <button
                      onClick={() => handlePickFile(mod)}
                      disabled={downloading !== null}
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

      {totalCount > 1 && (
        <div className="join flex justify-center flex-shrink-0">
          <button className="join-item btn" disabled={page === 1} onClick={() => setPage(p => p - 1)}>←</button>
          <span className="join-item btn btn-active">Page {page} / {totalCount}</span>
          <button className="join-item btn" disabled={page >= totalCount} onClick={() => setPage(p => p + 1)}>→</button>
        </div>
      )}
    </div>
    {filePickerMod && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
    <div className="bg-base-100 rounded-box shadow-xl p-5 w-96 max-h-[80vh] flex flex-col gap-3">
      <div className="flex justify-between items-center">
        <h3 className="font-bold text-sm">{filePickerMod.mod.name}</h3>
        <button className="btn btn-xs btn-ghost" onClick={() => setFilePickerMod(null)}>✕</button>
      </div>
      <p className="text-xs text-base-content/60">Select a version to install:</p>
      <div className="flex flex-col gap-2 overflow-y-auto">
        {filePickerMod.files.map((file, i) => (
          <div key={i} className="flex items-center justify-between border border-base-300 rounded p-2 gap-2">
            <div className="flex flex-col min-w-0">
              <span className="text-xs font-medium truncate">{file._sFile}</span>
              {file._sDescription && <span className="text-xs text-base-content/50 truncate">{file._sDescription}</span>}
              <span className="text-xs text-base-content/40">{(file._nFilesize / 1024).toFixed(1)} KB</span>
            </div>
            <button
              onClick={() => handleDownload(file)}
              className="btn btn-xs btn-primary flex-shrink-0"
            >
              Install
            </button>
          </div>
        ))}
      </div>
    </div>
  </div>
)}
</>
  );
}

function LogPanel({ logs, onClear }) {
  const convert = new AnsiToHtml();
  const logsEndRef = useRef(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

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
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState("tab1");
  const [modsDir, setModsDir] = useState(null);
  const [overwiteDir, setOverwiteDir] = useState(null);
  const [logs, setLogs] = useState([]);
  const [settings, setSettings] = useState({ theme: "light", game_dir: "" });

  const addLog = (message) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, `[${time}] ${message}`]);
  };

  useEffect(() => {
    invoke("get_main_dir", { folderName: "mods" }).then(setModsDir).catch(console.error);
    invoke("get_main_dir", { folderName: "overwrite" }).then(setOverwiteDir).catch(console.error);
    invoke("get_settings").then(setSettings).catch(console.error);
  }, []);

  useEffect(() => {
    if (settings.theme) document.documentElement.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    const handleContextMenu = (e) => e.preventDefault();
    window.addEventListener("contextmenu", handleContextMenu);
    return () => window.removeEventListener("contextmenu", handleContextMenu);
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
          {activeTab === "tab2" && <Tab2 modsDir={modsDir} addLog={addLog} />}
          {activeTab === "tab3" && <BrowseMods modsDir={modsDir} addLog={addLog} />}
          {activeTab === "settings" && <SettingsTab onSave={(s) => setSettings(s)} />}
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