import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import chalk from "chalk";
import { joinPath, getGmlDir } from "./pathUtils";

function ModCard({
  modPath,
  modName,
  selected = false,
  onSelect,
  contextMenu,
  setContextMenu,
}) {
  const [modData, setModData] = useState(null);

  useEffect(() => {
    const loadMod = async () => {
      try {
        const content = await invoke("read_item", {
          path: joinPath(modPath, "mod.json"),
        });
        const data = JSON.parse(content);
        setModData(data);
      } catch (e) {
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
    setContextMenu((prev) =>
      prev?.modName === modName
        ? null
        : { x: e.clientX, y: e.clientY, modName, modPath, modData },
    );
  };

  const handleOpenFolder = (e) => {
    e.stopPropagation();
    invoke("open_item", { path: modPath });
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
    const confirmed = await window.confirm(
      `Delete "${modData?.title || modName}"?`,
    );
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
        className={`border rounded-box transition-colors shadow-md overflow-hidden cursor-pointer
                    ${selected ? "border-primary bg-primary/20" : "border-base-300 hover:border-primary"}`}
        onClick={onSelect}
        onContextMenu={handleContextMenu}
      >
        {preview && (
          <img src={preview} alt={title} className="w-full h-32 object-cover" />
        )}
        <div className="card-body flex flex-col justify-center items-center p-4 text-center">
          <h2 className="card-title text-sm font-bold truncate">{title}</h2>
          <p className="text-xs text-gray-400 truncate">
            {submitter} • {cat}
          </p>

          {description && (
            <p className="text-xs mt-1 line-clamp-2">{description}</p>
          )}
          {modData?.homepage && (
            <a
              onClick={handleViewPage}
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

function ManageMods({ modsDir, overwiteDir, addLog, logs, onDropInstall, gmloaderInstalled }) {
  const [mods, setMods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedMod, setSelectedMod] = useState(null);
  const [operationRunning, setOperationRunning] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);

  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    const unlistenEnter = listen("tauri://drag-enter", () =>
      setIsDragOver(true),
    );
    const unlistenLeave = listen("tauri://drag-leave", () =>
      setIsDragOver(false),
    );
    const unlistenDrop = listen("tauri://drag-drop", async (event) => {
      setIsDragOver(false);
      for (const path of event.payload.paths) {
        if (/\.(zip|rar|7z)$/i.test(path)) {
          await onDropInstall(path);
        }
      }
    });
    return () => {
      unlistenEnter.then((f) => f());
      unlistenLeave.then((f) => f());
      unlistenDrop.then((f) => f());
    };
  }, [modsDir]);

  const fetchMods = () => {
    if (!modsDir) return;
    invoke("list_mods", { modsPath: modsDir })
      .then((folders) => setMods(folders))
      .catch((e) => {
        console.error(e);
        addLog(`Error loading mods`);
      })
      .finally(() => setLoading(false));
  };

  const filteredMods = mods.filter((mod) =>
    mod.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  useEffect(() => {
    const unlisten = listen("prepare-log", (event) => {
      addLog(event.payload);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    fetchMods();
    if (operationRunning) return;
    const interval = setInterval(fetchMods, 2000);
    return () => clearInterval(interval);
  }, [modsDir]);

  const handleRunFile = async (mode = "full") => {
    if (operationRunning) return;

    setOperationRunning(true);
    addLog(chalk.yellow("Preparing overwrite..."));

    try {
      const vfsRoot = await invoke("get_main_dir", { folderName: "modfolder" });
      const settingsData = await invoke("get_settings");
      let effectiveSettings = { ...settingsData };
      if (selectedMod) {
        try {
          const modSettingsRaw = await invoke("read_item", {
            path: joinPath(modsDir, selectedMod, "settings.json"),
          });
          const modSettings = JSON.parse(modSettingsRaw);
          effectiveSettings = { ...effectiveSettings, ...modSettings };
        } catch (_) {
          // ignore
        }
      }
      const gmlDir = getGmlDir(modsDir);
      if (mode !== "launch") {
        await invoke("prepare_overwrite", {
          mods: selectedMod ? [selectedMod] : [],
          modsPath: modsDir,
          overwritePath: overwiteDir,
          gameDir: effectiveSettings.game_dir,
          prepatch: effectiveSettings.prepatch || "",
          gmloaderEnabled:
            effectiveSettings.gmloader_enabled ?? gmloaderEnabled,
          dataTarget: effectiveSettings.data_target || "data.win",
          gmlModsPath: gmlDir,
        });
      }
      if (mode === "over") setOperationRunning(false);
      if (mode !== "over") {
        const launchType = effectiveSettings.reverse_mounting ? "reverse" : "normal";

        if (launchType === "reverse") {
          const hasBackup = await invoke("check_backup_exists", { gameDir: effectiveSettings.game_dir });
          if (hasBackup) {
            const restore = window.confirm(
              "A backup from a previous Reverse Mounting session was found.\n\nDo you want to restore original files before deploying new mods? This prevents backing up already-modded files.\n\nClick OK to restore first (recommended), or Cancel to overwrite without restoring."
            );
            if (restore) {
              addLog(chalk.yellow("Restoring original files from backup before deploying..."));
              await invoke("unmount_vfs", {
                vfsRoot,
                launchType: "reverse",
                gameDir: effectiveSettings.game_dir,
              });
              addLog(chalk.green("Original files restored"));
            }
          }
        }

        addLog(chalk.yellow(effectiveSettings.reverse_mounting ? "Deploying mods to game directory..." : "Setting up mod folder..."));

        await invoke("mount_vfs", {
          gameDir: effectiveSettings.game_dir,
          overwritePath: overwiteDir,
          vfsRoot,
          steamApi: effectiveSettings.steam_api ?? false,
          gmloaderEnabled:
            effectiveSettings.gmloader_enabled ?? gmloaderEnabled,
          launchType,
        });

        const GMLOADER_EXE = "GMLoader.exe";
        if (gmloaderEnabled) {
          const unlistenOutput = await listen("process-output", (event) => {
            if (
              event.payload.exe ===
              (effectiveSettings.gmloader_exe || GMLOADER_EXE)
            ) {
              var c = event.payload.line;
              var b = c.slice(15);
              var a = c.slice(10, 13);
              var cancel = false;
              if (
                c.endsWith(
                  "Warning, checkHash is false, make sure that you know what your doing. Reading game data from data.win",
                ) ||
                c.endsWith("o close...") ||
                c.endsWith(
                  "Cannot read keys when either application does not have a console or when console input has been redirected. Try Console.Read.",
                ) ||
                c.endsWith("nsolePal.ReadKey(Boolean intercept)") ||
                c.endsWith(
                  "GMLoaderProgram.Main(String[] args) in C:\\Hub\\Modding\\Project\\GMLoader\\GMLoader\\Program.cs:line 726",
                )
              )
                cancel = true; // Ignore AutoRestart Crash for fixing the lame thing
              if (a === "WRN") b = chalk.yellow(b);
              if (a === "ERR") b = chalk.red(b);
              if (!cancel) addLog(b);
            }
          });
          await invoke("launch_game", {
            vfsRoot,
            exeName: effectiveSettings.gmloader_exe || GMLOADER_EXE,
            launchArgs: [],
            launchType: effectiveSettings.reverse_mounting ? "reverse" : "normal",
          });

          addLog(chalk.green("Executing GMLoader process..."));

          const waitGmloader = await listen("process-ended", async (event) => {
            if (
              event.payload === (effectiveSettings.gmloader_exe || GMLOADER_EXE)
            ) {
              waitGmloader();
              unlistenOutput();
              addLog(
                chalk.yellow(
                  "GMLoader Process finished, launching the game...",
                ),
              );
              await invoke("kill_process", {
                name: effectiveSettings.exe_name || "PizzaTower.exe",
              });
              launchPizzaTower();
            }
          });
        } else {
          addLog(chalk.yellow("Launching the game..."));
          launchPizzaTower();
        }
      }

      async function launchPizzaTower() {
        const launchType = effectiveSettings.reverse_mounting ? "reverse" : "normal";

        await invoke("launch_game", {
          vfsRoot,
          exeName: effectiveSettings.exe_name || "PizzaTower.exe",
          launchArgs: effectiveSettings.launch_args || [],
          launchType,
        });

        addLog(chalk.green("Game is running"));

        const waitEnd = await listen("process-ended", async (event) => {
          const exeName = effectiveSettings.exe_name || "PizzaTower.exe";
          if (event.payload === exeName) {
            waitEnd();
            if (launchType === "reverse") {
              addLog(chalk.yellow("Game closed, restoring original files from backup..."));
              await invoke("unmount_vfs", {
                vfsRoot,
                launchType: "reverse",
                gameDir: effectiveSettings.game_dir,
              });
              addLog(chalk.green("Original files restored"));
            } else {
              addLog(chalk.yellow("Game closed, cleaning mod folder..."));
              await invoke("unmount_vfs", {
                vfsRoot,
                launchType: "normal",
                gameDir: "",
              });
              addLog(chalk.green("Mod folder cleaned"));
            }
            setOperationRunning(false);
          }
        });
      }
    } catch (e) {
      addLog(chalk.red(`Error: ${e}`));
      setOperationRunning(false);
    }
  };

  const handleSelectMod = (modName) => {
    setSelectedMod((prev) => (prev === modName ? null : modName));
  };

  const [gmloaderEnabled, setGmloaderEnabled] = useState(false);

  const useMods = selectedMod || gmloaderEnabled;

  useEffect(() => {
    if (!gmloaderInstalled) {
      setGmloaderEnabled(false);
      return;
    }
    invoke("get_settings")
      .then((settings) =>
        setGmloaderEnabled(settings.gmloader_enabled ?? false),
      )
      .catch(() => setGmloaderEnabled(false));
  }, [gmloaderInstalled]);

  const handleToggleGML = async (e) => {
    const val = e.target.checked;
    setGmloaderEnabled(val);
    const exeDir = await invoke("get_main_dir", { folderName: "" });
    const settings = await invoke("get_settings");
    await invoke("edit_item", {
      path: joinPath(exeDir, "settings.json"),
      content: JSON.stringify({ ...settings, gmloader_enabled: val }, null, 2),
    });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
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

      <div className="flex gap-3 mb-3 flex-shrink-0 items-center">
        <div className={`join`}>
          <button
            onClick={async () => {
              if (operationRunning) {
                const confirmed = await window.confirm(
                  "Are you sure you want to stop?",
                );
                if (confirmed) {
                  try {
                    await invoke("force_stop_game");
                    setOperationRunning(false);
                  } catch (e) {
                    addLog(`Error stopping: ${e}`);
                  }
                }
                return;
              }
              handleRunFile();
            }}
            disabled={!operationRunning && false}
            className={`btn join-item ${operationRunning ? "btn-error" : "btn-primary"}`}
          >
            {operationRunning ? "Stop?" : "Launch"}
          </button>
          {!operationRunning && (
            <div className="dropdown dropdown-bottom dropdown-center">
              <button
                tabIndex={0}
                className="btn btn-primary join-item px-2"
              >
                ▾
              </button>
              <ul
                tabIndex={0}
                className="dropdown-content menu bg-base-100 rounded-box shadow-lg z-50 w-40 mt-1"
              >
                <li className={!useMods ? "opacity-50 pointer-events-none" : ""}>
                  <a
                    onClick={() => {
                      if (!useMods) return;
                      document.activeElement.blur();
                      handleRunFile("over");
                    }}
                  >
                    Overwrite Only
                  </a>
                </li>
                <li>
                  <a
                    onClick={() => {
                      document.activeElement.blur();
                      handleRunFile("launch");
                    }}
                  >
                    Launch Only
                  </a>
                </li>
              </ul>
            </div>
          )}
        </div>
        <label
          className={`flex items-center gap-2 cursor-pointer ${
            !gmloaderInstalled ? "tooltip tooltip-right tooltip-error" : ""
          }`}
          {...(!gmloaderInstalled
            ? {
                "data-tip":
                  "GMLoader is not installed, go to settings to install it.",
              }
            : {})}
        >
          <span className="text-sm">GMLoader</span>
          <input
            type="checkbox"
            className="toggle toggle-primary toggle-sm"
            checked={gmloaderEnabled}
            disabled={!gmloaderInstalled}
            onChange={handleToggleGML}
          />
        </label>
      </div>

      <div
        className={`flex-1 overflow-auto h-full transition-colors ${isDragOver ? "outline-dashed outline-2 outline-primary bg-primary/5 rounded-box" : ""}`}
      >
        {isDragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
            <p className="text-primary font-bold text-lg">
              Drop mod to install
            </p>
          </div>
        )}
        {loading && <p className="text-sm">Loading...</p>}
        {!loading && mods.length === 0 && (
          <div className="text-center text-xl">
            <h1>Drag your mod file here</h1>
            <p className="text-sm text-secondary-content">
              No mods found in {modsDir}
            </p>
          </div>
        )}
        {!loading && mods.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {filteredMods.map((mod) => (
              <ModCard
                key={mod}
                modName={mod}
                modPath={joinPath(modsDir, mod)}
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
            <a
              onClick={() => {
                invoke("open_item", {
                  path: contextMenu.modPath,
                });
                setContextMenu(null);
              }}
            >
              Open Folder
            </a>
          </li>
          {contextMenu.modData?.homepage && (
            <li>
              <a
                onClick={() => {
                  openUrl(contextMenu.modData.homepage);
                  setContextMenu(null);
                }}
              >
                View Page
              </a>
            </li>
          )}
          <li>
            <a
              className="text-error"
              onClick={async () => {
                setContextMenu(null);
                const confirmed = await window.confirm(
                  `Delete "${contextMenu.modData?.title || contextMenu.modName}"?`,
                );
                if (confirmed)
                  await invoke("remove_item", {
                    path: contextMenu.modPath.replace(/\//g, "\\"),
                  });
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

export default ManageMods;
