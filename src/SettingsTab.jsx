import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { joinPath } from "./pathUtils";
import "./App.css";
const themes = ["light", "dark"];

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

  useEffect(() => {
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
  }, []);

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
