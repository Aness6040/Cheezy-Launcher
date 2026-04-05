use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use sysinfo::{ProcessesToUpdate, System};
use tauri::Emitter;
use tauri::{Manager, State};
use tauri_plugin_single_instance::init as single_instance;

#[derive(Default)]
struct AppState {
    operation_running: bool,
    game_pid: Option<u32>,
}

type SharedState = Arc<Mutex<AppState>>;

#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    theme: String,
    #[serde(default)]
    launch_args: Vec<String>,
    #[serde(default)]
    game_dir: String,
    #[serde(default)]
    game_data_dir: String,
    #[serde(default)]
    prepatch: String,
    #[serde(default)]
    steam_api: bool,
    #[serde(default)]
    gmloader_enabled: bool,
}

fn detect_archive_type(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x50, 0x4B, 0x03, 0x04]) || bytes.starts_with(&[0x50, 0x4B, 0x05, 0x06]) {
        "zip"
    } else if bytes.starts_with(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) {
        "7z"
    } else if bytes.starts_with(&[0x52, 0x61, 0x72, 0x21]) {
        "rar"
    } else {
        "unknown"
    }
}

#[tauri::command]
fn get_settings() -> Result<Settings, String> {
    let exe_dir = exe_dir()?;
    let config_path = exe_dir.join("settings.json");
    if !config_path.exists() {
        let game_dir = steamlocate::SteamDir::locate()
            .ok()
            .and_then(|s| s.find_app(2231450).ok().flatten())
            .map(|(app, lib)| {
                lib.path()
                    .join("steamapps")
                    .join("common")
                    .join(&app.install_dir)
                    .to_string_lossy()
                    .to_string()
            })
            .unwrap_or_default();

        let game_data_dir = std::env::var("APPDATA")
            .map(|p| {
                Path::new(&p)
                    .join("PizzaTower_GM2")
                    .to_string_lossy()
                    .to_string()
            })
            .unwrap_or_default();

        let default = Settings {
            theme: "light".to_string(),
            launch_args: Vec::new(),
            game_dir,
            game_data_dir,
            prepatch: String::new(),
            steam_api: true,
            gmloader_enabled: false,
        };
        fs::write(
            &config_path,
            serde_json::to_string_pretty(&default).unwrap(),
        )
        .map_err(|e| e.to_string())?;
    }

    let content = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    let mut settings: Settings = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    // Auto-détecter si les paths sont vides
    let mut changed = false;

    if settings.game_dir.is_empty() {
        if let Some(path) = steamlocate::SteamDir::locate()
            .ok()
            .and_then(|s| s.find_app(2231450).ok().flatten())
            .map(|(app, lib)| {
                lib.path()
                    .join("steamapps")
                    .join("common")
                    .join(&app.install_dir)
                    .to_string_lossy()
                    .to_string()
            })
        {
            settings.game_dir = path;
            changed = true;
        }
    }

    if settings.game_data_dir.is_empty() {
        if let Ok(appdata) = std::env::var("APPDATA") {
            settings.game_data_dir = Path::new(&appdata)
                .join("PizzaTower_GM2")
                .to_string_lossy()
                .to_string();
            changed = true;
        }
    }

    if changed {
        fs::write(
            &config_path,
            serde_json::to_string_pretty(&settings).unwrap(),
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(settings)
}

fn exe_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    exe.parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "No exe dir".to_string())
}

fn normalize_path(path: &str) -> PathBuf {
    PathBuf::from(path.replace("/", "\\"))
}

fn get_xdelta_path() -> Result<PathBuf, String> {
    Ok(exe_dir()?.join("deps").join("xdelta3.exe"))
}

#[tauri::command]
fn get_main_dir(folder_name: String) -> Result<String, String> {
    let dir = exe_dir()?.join(&folder_name);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn list_mods(mods_path: String) -> Result<Vec<String>, String> {
    let entries = fs::read_dir(&mods_path).map_err(|e| e.to_string())?;
    Ok(entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect())
}

#[tauri::command]
fn add_item(path: String, is_dir: bool) -> Result<(), String> {
    if is_dir {
        fs::create_dir_all(&path)
    } else {
        fs::File::create(&path).map(|_| ())
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_item(path: String) -> Result<(), String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        fs::remove_dir_all(&path)
    } else {
        fs::remove_file(&path)
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_item(old_path: String, new_path: String) -> Result<(), String> {
    fs::rename(&old_path, &new_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_item(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn edit_item(path: String, content: String) -> Result<(), String> {
    use std::io::Write;
    let mut f = fs::File::create(&path).map_err(|e| e.to_string())?;
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn move_item(src_path: String, dest_path: String) -> Result<(), String> {
    fs::rename(&src_path, &dest_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_item(path: String) -> Result<(), String> {
    let result = match std::env::consts::OS {
        "macos" => Command::new("open").arg(&path).spawn(),
        "windows" => Command::new("explorer").arg(&path).spawn(),
        "linux" => Command::new("xdg-open").arg(&path).spawn(),
        _ => return Err("Unsupported OS".into()),
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn apply_xdelta_patch(
    source: String,
    patch: String,
    output: String,
    overwrite: bool,
) -> Result<(), String> {
    let xdelta = get_xdelta_path()?;
    let source_path = normalize_path(&source);
    let patch_path = normalize_path(&patch);
    let output_path = normalize_path(&output);

    if !source_path.exists() {
        return Err("Source file not found".into());
    }
    if !patch_path.exists() {
        return Err("Patch file not found".into());
    }

    let mut cmd = Command::new(&xdelta);
    cmd.arg("-d");
    if overwrite {
        cmd.arg("-f");
    }
    cmd.arg("-s")
        .arg(&source_path)
        .arg(&patch_path)
        .arg(&output_path);

    let status = cmd
        .status()
        .map_err(|e| format!("xdelta launch error: {}", e))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "xdelta error, code: {}",
            status.code().unwrap_or(-1)
        ))
    }
}

#[tauri::command]
fn prepare_overwrite(
    mods: Vec<String>,
    mods_path: String,
    overwrite_path: String,
    game_dir: String,
    prepatch: String,
    gmloader_enabled: bool,
    gml_mods_path: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let log = |msg: &str| {
        let _ = app_handle.emit("prepare-log", msg.to_string());
    };

    let over = Path::new(&overwrite_path);
    let game_path = Path::new(&game_dir);

    log("Clearing overwrite folder...");
    if over.exists() {
        fs::remove_dir_all(over).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(over).map_err(|e| e.to_string())?;

    let xdelta = get_xdelta_path()?;

    log("Listing game files...");
    let game_files: Vec<PathBuf> = walkdir::WalkDir::new(game_path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .map(|e| e.path().to_path_buf())
        .collect();

    log(&format!("{} game files found", game_files.len()));

    for mod_name in &mods {
        let mod_dir = Path::new(&mods_path).join(mod_name);
        if !mod_dir.is_dir() {
            continue;
        }

        log(&format!("Processing mod: {}", mod_name));

        let root_entries: Vec<_> = fs::read_dir(&mod_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .collect();

        let root_files: Vec<_> = root_entries.iter().filter(|e| e.path().is_file()).collect();

        let root_dirs: Vec<_> = root_entries.iter().filter(|e| e.path().is_dir()).collect();

        let has_patch_at_root = root_files.iter().any(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            name.ends_with(".xdelta") || name == "data.win"
        });

        let mod_base = if !has_patch_at_root
            && root_dirs.len() == 1
            && !game_path.join(root_dirs[0].file_name()).exists()
        {
            log(&format!(
                "  Base: subfolder {}",
                root_dirs[0].file_name().to_string_lossy()
            ));
            root_dirs[0].path()
        } else {
            log("  Base: root");
            mod_dir.clone()
        };

        let mut all_entries: Vec<_> = walkdir::WalkDir::new(&mod_base)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .collect();

        all_entries.sort_by_key(|e| e.path().to_path_buf());
        log("Copying files...");
        for entry in &all_entries {
            let file_name = entry
                .path()
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();

            if file_name == "mod.json" {
                continue;
            }
            if file_name.ends_with(".xdelta") {
                continue;
            }

            let rel = entry
                .path()
                .strip_prefix(&mod_base)
                .map_err(|e| e.to_string())?;
            let dest = over.join(rel);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(entry.path(), &dest).map_err(|e| e.to_string())?;
            log(&format!("    Copied: {}", rel.display()));
        }

        if !prepatch.is_empty() {
            log("Finding prepatch...");
            let prepatch_path = exe_dir()?
                .join("prepatches")
                .join(format!("{}.xdelta", prepatch));
            if prepatch_path.exists() {
                log(&format!("Applying prepatch: {}", prepatch));

                let source = game_files
                    .iter()
                    .find(|f| {
                        f.file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_lowercase()
                            == "data.win.po"
                    })
                    .or_else(|| {
                        game_files.iter().find(|f| {
                            f.file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_lowercase()
                                == "data.win"
                        })
                    })
                    .ok_or_else(|| "data.win not found for prepatch".to_string())?;

                let dest = over.join("data.win");
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }

                let status = Command::new(&xdelta)
                    .args(["-d", "-f", "-s"])
                    .arg(source)
                    .arg(&prepatch_path)
                    .arg(&dest)
                    .status()
                    .map_err(|e| e.to_string())?;

                if status.success() {
                    log(&format!("  ✓ Prepatch applied -> data.win"));
                } else {
                    return Err(format!("Prepatch failed: {}", prepatch));
                }
            }
        }

        log("Applying patches...");
        for entry in &all_entries {
            let file_name = entry
                .path()
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();

            if !file_name.ends_with(".xdelta") {
                continue;
            }

            log(&format!("  Patching: {}", file_name));
            let mut patched = false;

            // Candidats : overwrite/ en priorité, puis jeu (.po > brut)
            let mut candidates: Vec<PathBuf> = Vec::new();

            if over.exists() {
                for ow_entry in walkdir::WalkDir::new(over) {
                    let ow_entry = ow_entry.map_err(|e| e.to_string())?;
                    if !ow_entry.path().is_file() {
                        continue;
                    }
                    candidates.push(ow_entry.path().to_path_buf());
                }
            }

            for game_file in &game_files {
                let po_path = {
                    let mut p = game_file.clone();
                    p.set_file_name(format!(
                        "{}.po",
                        game_file.file_name().unwrap_or_default().to_string_lossy()
                    ));
                    p
                };
                if po_path.exists() {
                    candidates.push(po_path);
                }
                candidates.push(game_file.clone());
            }

            for source in &candidates {
                let (dest, use_tmp) = if source.starts_with(over) {
                    (source.clone(), true)
                } else {
                    let rel = if source
                        .extension()
                        .map(|e| e.to_string_lossy().to_lowercase())
                        .unwrap_or_default()
                        .ends_with("po")
                    {
                        let without_po = source.with_extension("");
                        without_po
                            .strip_prefix(game_path)
                            .map(|r| r.to_path_buf())
                            .unwrap_or_else(|_| without_po.file_name().unwrap().into())
                    } else {
                        source
                            .strip_prefix(game_path)
                            .map(|r| r.to_path_buf())
                            .unwrap_or_else(|_| source.file_name().unwrap().into())
                    };
                    (over.join(rel), false)
                };

                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }

                let tmp = dest.parent().unwrap().join(format!(
                    "{}_patch_tmp",
                    dest.file_name().unwrap().to_string_lossy()
                ));
                let actual_dest = if use_tmp { &tmp } else { &dest };

                let status = Command::new(&xdelta)
                    .args(["-d", "-f", "-s"])
                    .arg(source)
                    .arg(entry.path())
                    .arg(actual_dest)
                    .status()
                    .map_err(|e| e.to_string())?;

                if status.success() {
                    if use_tmp {
                        fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
                    }
                    log(&format!(
                        "    ✓ Patched -> {}",
                        dest.strip_prefix(over).unwrap_or(&dest).display()
                    ));
                    patched = true;
                    break;
                } else {
                    if tmp.exists() {
                        let _ = fs::remove_file(&tmp);
                    }
                }
            }

            if !patched {
                let msg = format!("    ✗ No source found for: {}", file_name);
                log(&msg);
                return Err(msg);
            }
        }
    }

    if gmloader_enabled {
        let gml_path = Path::new(&gml_mods_path);
        let mods_json = gml_path.join("mods.json");

        if mods_json.exists() {
            let content = fs::read_to_string(&mods_json).map_err(|e| e.to_string())?;
            let gml_mods: Vec<(String, bool)> =
                serde_json::from_str(&content).map_err(|e| e.to_string())?;

            for (mod_name, enabled) in gml_mods.iter().rev() {
                if !enabled {
                    continue;
                }

                let mod_dir = gml_path.join(mod_name);
                if !mod_dir.is_dir() {
                    continue;
                }

                log(&format!("  GML: applying {}", mod_name));

                for entry in walkdir::WalkDir::new(&mod_dir) {
                    let entry = entry.map_err(|e| e.to_string())?;
                    if !entry.path().is_file() {
                        continue;
                    }

                    let rel = entry
                        .path()
                        .strip_prefix(&mod_dir)
                        .map_err(|e| e.to_string())?;
                    let dest = over.join(rel);

                    if let Some(parent) = dest.parent() {
                        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                    fs::copy(entry.path(), &dest).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    log("Overwrite ready ✓");
    Ok(())
}

fn run_xdelta(xdelta: &Path, source: &Path, patch: &Path, output: &Path) -> Result<(), String> {
    let status = Command::new(xdelta)
        .args(["-d", "-f", "-s"])
        .arg(source)
        .arg(patch)
        .arg(output)
        .status()
        .map_err(|e| format!("xdelta launch error: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("xdelta failed ({})", status.code().unwrap_or(-1)))
    }
}

fn find_file_recursive(dir: &Path, name: &str) -> Result<Option<PathBuf>, String> {
    let name_lower = name.to_lowercase();
    for entry in walkdir::WalkDir::new(dir).min_depth(0) {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().is_file() {
            if entry
                .path()
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase()
                == name_lower
            {
                return Ok(Some(entry.path().to_path_buf()));
            }
        }
    }
    Ok(None)
}

fn resolve_output_path(base: &Path, rel_parent: &Path, file_name: &str) -> PathBuf {
    base.join(rel_parent).join(file_name)
}

#[tauri::command]
fn mount_vfs(
    game_dir: String,
    overwrite_path: String,
    vfs_root: String,
    steam_api: bool,
    gmloader_enabled: bool,
) -> Result<(), String> {
    let game = Path::new(&game_dir);
    let over = Path::new(&overwrite_path);
    let root = Path::new(&vfs_root);

    if root.exists() {
        fs::remove_dir_all(root).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;

    for entry in walkdir::WalkDir::new(game) {
        let entry = entry.map_err(|e| e.to_string())?;
        let rel = entry.path().strip_prefix(game).map_err(|e| e.to_string())?;
        let dest = root.join(rel);

        if entry.path().is_dir() {
            fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            #[cfg(windows)]
            std::os::windows::fs::symlink_file(entry.path(), &dest)
                .or_else(|_| fs::copy(entry.path(), &dest).map(|_| ()))
                .map_err(|e| e.to_string())?;
            #[cfg(not(windows))]
            std::os::unix::fs::symlink(entry.path(), &dest).map_err(|e| e.to_string())?;
        }
    }

    for entry in walkdir::WalkDir::new(over) {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.path().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(over).map_err(|e| e.to_string())?;
        let dest = root.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if dest.exists() {
            fs::remove_file(&dest).map_err(|e| e.to_string())?;
        }
        fs::copy(entry.path(), &dest).map_err(|e| e.to_string())?;
    }

    if gmloader_enabled {
        let data_win_dest = over.join("data.win");

        if !data_win_dest.exists() {
            let data_win_src = game.join("data.win");

            if data_win_src.exists() {
                // 1️⃣ Copier dans overwrite
                fs::create_dir_all(data_win_dest.parent().unwrap()).map_err(|e| e.to_string())?;
                fs::copy(&data_win_src, &data_win_dest).map_err(|e| e.to_string())?;
            }
        }

        let vfs_data_win_dest = root.join("data.win");

        if vfs_data_win_dest.exists() {
            fs::remove_file(&vfs_data_win_dest).map_err(|e| e.to_string())?;
        }

        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&data_win_dest, &vfs_data_win_dest)
            .or_else(|_| fs::copy(&data_win_dest, &vfs_data_win_dest).map(|_| ())) // fallback
            .map_err(|e| e.to_string())?;

        #[cfg(unix)]
        std::os::unix::fs::symlink(&data_win_dest, &vfs_data_win_dest)
            .map_err(|e| e.to_string())?;
        let gmloader_src = exe_dir()?.join("deps").join("GMLoader");

        if gmloader_src.exists() {
            for entry in walkdir::WalkDir::new(&gmloader_src) {
                let entry = entry.map_err(|e| e.to_string())?;
                let rel = entry
                    .path()
                    .strip_prefix(&gmloader_src)
                    .map_err(|e| e.to_string())?;

                if rel == Path::new("GMLoader.ini") {
                    let data_win_path = {
                        let ow = over.join("data.win");
                        if ow.exists() {
                            ow
                        } else {
                            game.join("data.win")
                        }
                    };

                    let mut content =
                        fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
                    if data_win_path.exists() {
                        let bytes = fs::read(&data_win_path).map_err(|e| e.to_string())?;
                        let hash = xxhash_rust::xxh3::xxh3_64(&bytes);
                        content = content
                            .lines()
                            .map(|line| {
                                if line.starts_with("SupportedDataHash=") {
                                    format!("SupportedDataHash={}", hash)
                                } else if line.starts_with("CheckHash=") {
                                    "CheckHash=false".to_string()
                                } else if line.starts_with("AutoGameStart=") {
                                    "AutoGameStart=true".to_string()
                                } else {
                                    line.to_string()
                                }
                            })
                            .collect::<Vec<_>>()
                            .join("\r\n");
                    }

                    // Copier dans overwrite
                    let overwrite_ini_path = over.join("GMLoader.ini");
                    fs::write(&overwrite_ini_path, &content).map_err(|e| e.to_string())?;

                    // Symlink dans root
                    let vfs_ini_dest = root.join("GMLoader.ini");
                    #[cfg(windows)]
                    std::os::windows::fs::symlink_file(&overwrite_ini_path, &vfs_ini_dest)
                        .or_else(|_| fs::copy(&overwrite_ini_path, &vfs_ini_dest).map(|_| ()))
                        .map_err(|e| e.to_string())?;
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(&overwrite_ini_path, &vfs_ini_dest)
                        .map_err(|e| e.to_string())?;

                    continue;
                }

                // Tout le reste -> symlink direct dans root
                let dest = root.join(rel);
                if entry.path().is_dir() {
                    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
                } else {
                    if let Some(parent) = dest.parent() {
                        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                    #[cfg(windows)]
                    std::os::windows::fs::symlink_file(entry.path(), &dest)
                        .or_else(|_| fs::copy(entry.path(), &dest).map(|_| ()))
                        .map_err(|e| e.to_string())?;
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(entry.path(), &dest).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    if steam_api {
        fs::write(root.join("steam_appid.txt"), "2231450").map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn unmount_vfs(vfs_root: String) -> Result<(), String> {
    let root = Path::new(&vfs_root);
    if root.exists() {
        fs::remove_dir_all(root).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn launch_game(
    vfs_root: String,
    exe_name: String,
    launch_args: Vec<String>,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        if s.operation_running {
            return Err("An operation is already in progress".into());
        }
        s.operation_running = true;
    }

    let exe_path = Path::new(&vfs_root).join(&exe_name);
    if !exe_path.exists() {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.operation_running = false;
        return Err(format!("Exe not found: {:?}", exe_path));
    }

    let child = Command::new(&exe_path)
        .current_dir(&vfs_root)
        .args(&launch_args)
        .spawn()
        .map_err(|e| {
            let mut s = state.lock().unwrap();
            s.operation_running = false;
            e.to_string()
        })?;

    let pid = child.id();
    {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.game_pid = Some(pid);
    }

    let state_clone = Arc::clone(&state);
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
        let mut s = state_clone.lock().unwrap();
        s.operation_running = false;
        s.game_pid = None;
    });

    Ok(())
}

#[tauri::command]
fn is_operation_running(state: State<'_, SharedState>) -> bool {
    state.lock().map(|s| s.operation_running).unwrap_or(false)
}

#[tauri::command]
fn force_stop_game(state: State<'_, SharedState>) -> Result<(), String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    if let Some(pid) = s.game_pid {
        #[cfg(windows)]
        {
            Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .status()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(windows))]
        {
            Command::new("kill")
                .arg(pid.to_string())
                .status()
                .map_err(|e| e.to_string())?;
        }
        s.game_pid = None;
        s.operation_running = false;
    }
    Ok(())
}
#[tauri::command]
fn download_mod(
    mod_name: String,
    mods_path: String,
    file_bytes: Vec<u8>,
    file_name: String,
) -> Result<(), String> {
    use std::io::Cursor;

    let mod_dir = Path::new(&mods_path).join(&mod_name);
    fs::create_dir_all(&mod_dir).map_err(|e| e.to_string())?;

    let archive_type = detect_archive_type(&file_bytes);
    if archive_type == "zip" {
        let cursor = Cursor::new(file_bytes);
        let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
        for i in 0..archive.len() {
            let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
            let out_path = mod_dir.join(file.name());
            if file.is_dir() {
                fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            } else {
                if let Some(parent) = out_path.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
                std::io::copy(&mut file, &mut out).map_err(|e| e.to_string())?;
            }
        }
    } else if archive_type == "7z" {
        let tmp_path = Path::new(&mods_path).join(&file_name);
        fs::write(&tmp_path, &file_bytes).map_err(|e| e.to_string())?;
        sevenz_rust::decompress_file(&tmp_path, &mod_dir).map_err(|e| e.to_string())?;
        fs::remove_file(&tmp_path).map_err(|e| e.to_string())?;
    } else if archive_type == "rar" {
        let tmp_path = Path::new(&mods_path).join(&file_name);
        fs::write(&tmp_path, &file_bytes).map_err(|e| e.to_string())?;
        sevenz_rust::decompress_file(&tmp_path, &mod_dir).map_err(|e| e.to_string())?;
        fs::remove_file(&tmp_path).map_err(|e| e.to_string())?;
    } else {
        let out_path = mod_dir.join(&file_name);
        fs::write(&out_path, &file_bytes).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn install_local_mod(mod_name: String, mods_path: String, file_path: String) -> Result<(), String> {
    let file_bytes = fs::read(&file_path).map_err(|e| e.to_string())?;
    let file_name = Path::new(&file_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let mod_dir = Path::new(&mods_path).join(&mod_name);
    fs::create_dir_all(&mod_dir).map_err(|e| e.to_string())?;

    let archive_type = detect_archive_type(&file_bytes);

    if archive_type == "zip" {
        use std::io::Cursor;
        let cursor = Cursor::new(file_bytes);
        let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
        for i in 0..archive.len() {
            let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
            let out_path = mod_dir.join(file.name());
            if file.is_dir() {
                fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            } else {
                if let Some(parent) = out_path.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
                std::io::copy(&mut file, &mut out).map_err(|e| e.to_string())?;
            }
        }
    } else if archive_type == "7z" || archive_type == "rar" {
        let tmp_path = Path::new(&mods_path).join(&file_name);
        fs::write(&tmp_path, &file_bytes).map_err(|e| e.to_string())?;
        sevenz_rust::decompress_file(&tmp_path, &mod_dir).map_err(|e| e.to_string())?;
        fs::remove_file(&tmp_path).map_err(|e| e.to_string())?;
    } else {
        let out_path = mod_dir.join(&file_name);
        fs::write(&out_path, &file_bytes).map_err(|e| e.to_string())?;
    }

    // Flatten si un seul sous-dossier
    let entries: Vec<_> = fs::read_dir(&mod_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .collect();
    let files: Vec<_> = entries.iter().filter(|e| e.path().is_file()).collect();
    let dirs: Vec<_> = entries.iter().filter(|e| e.path().is_dir()).collect();

    if files.is_empty() && dirs.len() == 1 {
        let base_dir = dirs[0].path();
        for entry in walkdir::WalkDir::new(&base_dir) {
            let entry = entry.map_err(|e| e.to_string())?;
            let rel = entry.path().strip_prefix(&base_dir).map_err(|e| e.to_string())?;
            let dest = mod_dir.join(rel);
            if entry.path().is_dir() {
                fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            } else {
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::rename(entry.path(), &dest).map_err(|e| e.to_string())?;
            }
        }
        fs::remove_dir_all(&base_dir).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
async fn fetch_file(url: String) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    Ok(bytes.to_vec())
}

#[tauri::command]
fn detect_game_dir() -> Result<String, String> {
    const PIZZA_TOWER_APP_ID: u32 = 2231450;

    let steam_dir = steamlocate::SteamDir::locate().map_err(|e| e.to_string())?;

    let (app, lib) = steam_dir
        .find_app(PIZZA_TOWER_APP_ID)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Pizza Tower not found in Steam libraries".to_string())?;

    let game_path = lib
        .path()
        .join("steamapps")
        .join("common")
        .join(&app.install_dir);

    Ok(game_path.to_string_lossy().to_string())
}

#[tauri::command]
fn detect_game_data_dir() -> Result<String, String> {
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let path = Path::new(&appdata).join("PizzaTower_GM2");
            if path.exists() {
                return Ok(path.to_string_lossy().to_string());
            }
            return Ok(path.to_string_lossy().to_string());
        }
    }
    Err("Could not find AppData".to_string())
}

#[tauri::command]
fn get_mod_base_dir(mod_path: String) -> Result<String, String> {
    let path = Path::new(&mod_path);
    let entries: Vec<_> = fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .collect();

    let files: Vec<_> = entries.iter().filter(|e| e.path().is_file()).collect();
    let dirs: Vec<_> = entries.iter().filter(|e| e.path().is_dir()).collect();

    if files.is_empty() && dirs.len() == 1 {
        return Ok(dirs[0].path().to_string_lossy().to_string());
    }

    Ok(mod_path)
}

#[tauri::command]
fn flatten_mod_dir(mod_path: String) -> Result<(), String> {
    let mod_dir = Path::new(&mod_path);
    let entries: Vec<_> = fs::read_dir(mod_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .collect();

    let files: Vec<_> = entries.iter().filter(|e| e.path().is_file()).collect();
    let dirs: Vec<_> = entries.iter().filter(|e| e.path().is_dir()).collect();

    if files.is_empty() && dirs.len() == 1 {
        let base_dir = dirs[0].path();

        for entry in walkdir::WalkDir::new(&base_dir) {
            let entry = entry.map_err(|e| e.to_string())?;
            let rel = entry
                .path()
                .strip_prefix(&base_dir)
                .map_err(|e| e.to_string())?;
            let dest = mod_dir.join(rel);

            if entry.path().is_dir() {
                fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            } else {
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::rename(entry.path(), &dest).map_err(|e| e.to_string())?;
            }
        }

        fs::remove_dir_all(&base_dir).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn list_prepatches() -> Result<Vec<String>, String> {
    let dir = exe_dir()?.join("prepatches");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        return Ok(vec![]);
    }
    Ok(fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "xdelta").unwrap_or(false))
        .filter_map(|e| {
            e.path()
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
        })
        .collect())
}

#[tauri::command]
fn is_process_running(name: String) -> bool {
    let mut system = System::new_all();

    system.refresh_processes(ProcessesToUpdate::All, true);

    let target = name.to_lowercase();

    system.processes().values().any(|process| {
        let proc_name = process.name().to_string_lossy().to_lowercase();

        proc_name == target || proc_name.contains(&target)
    })
}

#[tauri::command]
fn kill_process(name: String) -> usize {
    let mut system = System::new_all();

    system.refresh_processes(ProcessesToUpdate::All, true);

    let target = name.to_lowercase();
    let mut killed = 0;

    for process in system.processes().values() {
        let proc_name = process.name().to_string_lossy().to_lowercase();
        if proc_name == target {
            if process.kill() {
                killed += 1;
            }
        }
    }

    killed
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared_state: SharedState = Arc::new(Mutex::new(AppState::default()));

    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .manage(shared_state)
        .setup(|app| {
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
            use tauri_plugin_deep_link::DeepLinkExt;
            app.deep_link().register_all()?;
            }
            Ok(())
        })
        .plugin(single_instance(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                w.set_focus().unwrap();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            get_main_dir,
            list_mods,
            add_item,
            remove_item,
            rename_item,
            read_item,
            edit_item,
            move_item,
            open_item,
            apply_xdelta_patch,
            prepare_overwrite,
            mount_vfs,
            unmount_vfs,
            launch_game,
            is_operation_running,
            force_stop_game,
            download_mod,
            install_local_mod,
            fetch_file,
            detect_game_dir,
            detect_game_data_dir,
            get_mod_base_dir,
            flatten_mod_dir,
            list_prepatches,
            is_process_running,
            kill_process,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
