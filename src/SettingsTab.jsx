import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { joinPath } from "./pathUtils";
import "./App.css";
const themes = ["light", "dark"];
import { platform } from "@tauri-apps/plugin-os";

const GMLOADER_TOOL_ID = 18118;

function SettingsTab({ onSave, applyTheme }) {
  const [settings, setSettings] = useState({
    theme: "",
    launch_args: [],
    game_dir: "",
    game_data_dir: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [prepatches, setPrepatches] = useState([]);
  const [customThemes, setCustomThemes] = useState([]);
  const [os, setOs] = useState(null);

  // GMLoader
  const [gmloaderInstalled, setGmloaderInstalled] = useState(false);
  const [gmloaderFiles, setGmloaderFiles] = useState(null);
  const [gmloaderFetching, setGmloaderFetching] = useState(false);
  const [gmloaderDownloading, setGmloaderDownloading] = useState(false);
  const [gmloaderProgress, setGmloaderProgress] = useState(null);

  useEffect(() => {
    setOs(platform());
    invoke("get_settings")
      .then((data) => {
        setSettings(data);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
    invoke("list_files_by_ext", { folder: "prepatches", ext: "xdelta" })
      .then(setPrepatches)
      .catch(console.error);
    invoke("list_files_by_ext", { folder: "themes", ext: "css" })
      .then(setCustomThemes)
      .catch(console.error);
    invoke("gmloader_installed")
      .then(setGmloaderInstalled)
      .catch(console.error);

    const unlisten = listen("gmloader-download-progress", (event) => {
      try {
        const data = JSON.parse(event.payload);
        setGmloaderProgress(data);
      } catch {}
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const handleFetchGmloaderFiles = async () => {
    setGmloaderFetching(true);
    try {
      const res = await fetch(
        `https://gamebanana.com/apiv11/Tool/${GMLOADER_TOOL_ID}?_csvProperties=_aFiles,_sName`,
      );
      const data = await res.json();
      const files = Object.values(data._aFiles || {});
      setGmloaderFiles(files);
    } catch (e) {
      alert(`Erreur lors de la récupération des fichiers : ${e}`);
    } finally {
      setGmloaderFetching(false);
    }
  };

  const handleDownloadGmloader = async (file) => {
    setGmloaderFiles(null);
    setGmloaderDownloading(true);
    setGmloaderProgress({ percent: 0, downloaded_mb: 0, total_mb: 0 });
    try {
      await invoke("download_gmloader", {
        fileId: file._idRow,
        fileName: file._sFile,
        downloadUrl: file._sDownloadUrl,
      });
      setGmloaderInstalled(true);
      alert("GMLoader successfully installed!");
    } catch (e) {
      alert(`Error during download: ${e}`);
    } finally {
      setGmloaderDownloading(false);
      setGmloaderProgress(null);
    }
  };

  const handleChange = async (e) => {
    const { name, value } = e.target;
    setSettings((prev) => ({ ...prev, [name]: value }));
    if (name === "theme") await applyTheme(value);
  };

  const handleBrowse = async (field) => {
    try {
      const path = await open({
        directory: true,
        multiple: false,
        defaultPath: settings[field] || undefined,
      });
      if (path) setSettings((prev) => ({ ...prev, [field]: path }));
    } catch (e) {}
  };

  const handleDetect = async (field) => {
    try {
      const cmd =
        field === "game_dir" ? "detect_game_dir" : "detect_game_data_dir";
      const path = await invoke(cmd);
      setSettings((prev) => ({ ...prev, [field]: path }));
    } catch (e) {
      alert(`Could not detect automatically: ${e}`);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const exeDir = await invoke("get_main_dir", { folderName: "" });
      await invoke("edit_item", {
        path: joinPath(exeDir, "settings.json"),
        content: JSON.stringify(settings, null, 2),
      });
      await applyTheme(settings.theme);
      onSave(settings);
      alert("Settings saved!");
    } catch (e) {
      console.error(e);
      alert("Error saving settings");
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return <p className="text-primary-content">Loading settings...</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col">
        <label className="mb-1 text-sm font-semibold">Theme</label>
        <select
          name="theme"
          value={settings.theme}
          onChange={handleChange}
          className="select select-bordered select-sm"
        >
          <optgroup label="Built-in">
            {themes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </optgroup>
          {customThemes.length > 0 && (
            <optgroup label="Custom">
              {customThemes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>

      <div className="flex items-center gap-2">
        <label className="text-sm font-semibold">Enable Steam API</label>
        <input
          type="checkbox"
          className="toggle toggle-primary"
          checked={settings.steam_api || false}
          onChange={(e) =>
            setSettings((prev) => ({ ...prev, steam_api: e.target.checked }))
          }
        />
      </div>
      <div className="flex items-center gap-2">
        <label className="text-sm font-semibold">Discord Rich Presence</label>
        <input
          type="checkbox"
          className="toggle toggle-primary"
          checked={settings.discord_rpc ?? true}
          onChange={(e) =>
            setSettings((prev) => ({ ...prev, discord_rpc: e.target.checked }))
          }
        />
      </div>

      <div className="flex flex-col">
        <label className="mb-1 text-sm font-semibold">Launch Arguments</label>
        <input
          type="text"
          placeholder="-debug"
          value={settings.launch_args?.join(" ") || ""}
          onChange={(e) =>
            setSettings((prev) => ({
              ...prev,
              launch_args: e.target.value
                .split(" ")
                .filter((a) => a.length > 0),
            }))
          }
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
          <button
            onClick={() => handleBrowse("game_dir")}
            className="btn btn-sm btn-outline"
          >
            Browse
          </button>
          <button
            onClick={() => handleDetect("game_dir")}
            className="btn btn-sm btn-outline"
          >
            Reset
          </button>
        </div>
      </div>

      <div className="flex flex-col">
        <label className="mb-1 text-sm font-semibold">
          Game Data Directory (AppData)
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            name="game_data_dir"
            value={settings.game_data_dir || ""}
            onChange={handleChange}
            placeholder="%APPDATA%\Pizza Tower"
            className="input input-bordered input-sm flex-1"
          />
          <button
            onClick={() => handleBrowse("game_data_dir")}
            className="btn btn-sm btn-outline"
          >
            Browse
          </button>
          <button
            onClick={() => handleDetect("game_data_dir")}
            className="btn btn-sm btn-outline"
          >
            Reset
          </button>
        </div>
      </div>

      <div className="flex flex-col">
        <label className="mb-1 text-sm font-semibold">
          Prepatch (Downgrade)
        </label>
        <select
          name="prepatch"
          value={settings.prepatch || ""}
          onChange={handleChange}
          className="select select-bordered select-sm"
        >
          <option value="">None</option>
          {prepatches.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      {os && os !== "windows" && (
        <div className="collapse collapse-arrow border border-base-300 bg-base-100 rounded-box">
          <input type="checkbox" />

          <div className="collapse-title text-sm font-semibold">
            Wine / Proton (Linux)
          </div>

          <div className="collapse-content flex flex-col gap-3">
            <select
              name="wine_mode"
              value={settings.wine_mode || "wine"}
              onChange={handleChange}
              className="select select-bordered select-sm"
            >
              <option value="wine">Wine (système)</option>
              <option value="proton">Proton (Steam stable)</option>
              <option value="proton_experimental">Proton Experimental</option>
              <option value="custom">Chemin custom</option>
            </select>

            {settings.wine_mode === "custom" && (
              <div className="flex gap-2">
                <input
                  type="text"
                  name="wine_path"
                  value={settings.wine_path || ""}
                  onChange={handleChange}
                  placeholder="/home/user/.local/share/Steam/steamapps/common/Proton 9.0/proton"
                  className="input input-bordered input-sm flex-1"
                />
                <button
                  onClick={() => handleBrowse("wine_path")}
                  className="btn btn-sm btn-outline"
                >
                  Browse
                </button>
              </div>
            )}

            <div className="flex flex-col">
              <label className="mb-1 text-xs text-base-content/60">
                WINEPREFIX (optionnel)
              </label>
              <input
                type="text"
                name="wine_prefix"
                value={settings.wine_prefix || ""}
                onChange={handleChange}
                placeholder="/home/user/.wine"
                className="input input-bordered input-sm"
              />
            </div>
          </div>
        </div>
      )}

      <div className="collapse collapse-arrow border border-base-300 bg-base-100 rounded-box">
        <input type="checkbox" />
        <div className="collapse-title text-sm font-semibold flex items-center gap-2">
          GMLoader
          <span
            className={`badge badge-xs ${gmloaderInstalled ? "badge-success" : "badge-error"}`}
          >
            {gmloaderInstalled ? "Installed" : "Not Installed"}
          </span>
        </div>
        <div className="collapse-content flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div
              className="text-sm font-semibold tooltip tooltip-right tooltip-warning tooltip-small"
              data-tip={`Enables "AutoGameStart" in the config to fix GMLoader not completing its process (this should be enabled on Linux).`}
            >
              Auto Restart{" "}
              <span className="badge badge-xs badge-info">Launch Fix</span>
            </div>
            <input
              type="checkbox"
              className="toggle toggle-primary"
              checked={settings.gmloader_auto_restart ?? false}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  gmloader_auto_restart: e.target.checked,
                }))
              }
            />
          </div>

          <div className="flex flex-col">
            <div
              className="text-sm font-semibold w-fit tooltip tooltip-right tooltip-secondary tooltip-small"
              data-tip="Use 'GMLoader.bin' instead of 'GMLoader.exe' if you chose native linux version in the download"
            >
              GMLoader Executable Name
            </div>

            <input
              type="text"
              name="gmloader_exe"
              value={settings.gmloader_exe || ""}
              onChange={handleChange}
              placeholder="GMLoader.exe"
              className="input input-bordered input-sm"
            />
          </div>

          {gmloaderDownloading && gmloaderProgress && (
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-xs text-base-content/60">
                <span>Downloading GMLoader...</span>
                <span>
                  {gmloaderProgress.downloaded_mb.toFixed(1)} /{" "}
                  {gmloaderProgress.total_mb.toFixed(1)} MB
                </span>
              </div>
              <progress
                className="progress progress-primary w-full"
                value={gmloaderProgress.percent}
                max="100"
              />
            </div>
          )}

          <button
            className="btn btn-sm btn-outline w-max"
            onClick={handleFetchGmloaderFiles}
            disabled={gmloaderFetching || gmloaderDownloading}
          >
            {gmloaderFetching
              ? "Loading..."
              : gmloaderInstalled
                ? "Update/Change GMLoader Version"
                : "Download GMLoader"}
          </button>
        </div>
      </div>

      {gmloaderFiles && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-base-100 rounded-box shadow-xl p-5 w-96 max-h-[80vh] flex flex-col gap-3">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-sm">Select a GMLoader version</h3>
              <button
                className="btn btn-xs btn-ghost"
                onClick={() => setGmloaderFiles(null)}
              >
                ✕
              </button>
            </div>
            <p className="text-xs text-base-content/60">
              Select a version to install in{" "}
              <code className="text-xs">deps/GMLoader/</code>
            </p>
            <div className="flex flex-col gap-2 overflow-y-auto">
              {gmloaderFiles.map((file, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between border border-base-300 rounded p-2 gap-2"
                >
                  <div className="flex flex-col min-w-0">
                    <span className="text-xs font-medium truncate">
                      {file._sFile}
                    </span>
                    {file._sDescription && (
                      <span className="text-xs text-base-content/50 truncate">
                        {file._sDescription}
                      </span>
                    )}
                    <span className="text-xs text-base-content/40">
                      {(file._nFilesize / 1024).toFixed(1)} KB
                    </span>
                  </div>
                  <button
                    onClick={() => handleDownloadGmloader(file)}
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

export default SettingsTab;
