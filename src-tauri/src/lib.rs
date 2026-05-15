use serde::{Deserialize, Serialize};
use std::fs;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use sysinfo::{ProcessesToUpdate, System};
use tauri::Emitter;
use tauri::{Manager, State};
use tauri_plugin_single_instance::init as single_instance;
use unrar::Archive;

#[derive(Default)]
struct AppState {
    operation_running: bool,
    game_pid: Option<u32>,
}

type SharedState = Arc<Mutex<AppState>>;
type SysState = Arc<Mutex<System>>;

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
    exe_name: String,
    #[serde(default)]
    gmloader_exe: String,
    #[serde(default)]
    data_target: String,
    #[serde(default)]
    prepatch: String,
    #[serde(default)]
    steam_api: bool,
    #[serde(default)]
    gmloader_enabled: bool,
    #[serde(default)]
    gmloader_auto_restart: bool,
    #[serde(default)]
    discord_rpc: bool,
    #[serde(default)]
    wine_mode: String, // "wine", "proton", "proton_experimental", "custom"
    #[serde(default)]
    wine_path: String, // custom path if wine_mode is"custom"
    #[serde(default)]
    wine_prefix: String, // custom WINEPREFIX (optional)
}

fn detect_archive_type(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x50, 0x4B, 0x03, 0x04]) || bytes.starts_with(&[0x50, 0x4B, 0x05, 0x06])
    {
        "zip"
    } else if bytes.starts_with(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) {
        "7z"
    } else if bytes.starts_with(&[0x52, 0x61, 0x72, 0x21]) {
        "rar"
    } else {
        "unknown"
    }
}

pub fn extract_rar(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;

    let mut archive = Archive::new(src)
        .open_for_processing()
        .map_err(|e| e.to_string())?;

    while let Some(header) = archive.read_header().map_err(|e| e.to_string())? {
        archive = if header.entry().is_file() {
            let entry_path = dst.join(header.entry().filename.to_string_lossy().replace('\\', "/"));
            if let Some(parent) = entry_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            header.extract_with_base(dst).map_err(|e| e.to_string())?
        } else {
            let dir_path = dst.join(header.entry().filename.to_string_lossy().replace('\\', "/"));
            fs::create_dir_all(&dir_path).map_err(|e| e.to_string())?;
            header.skip().map_err(|e| e.to_string())?
        };
    }

    Ok(())
}

#[tauri::command]
fn get_settings() -> Result<Settings, String> {
    let exe_dir = exe_dir()?;
    let config_path = exe_dir.join("settings.json");

    if config_path.exists() {
        let content = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        let mut settings: Settings = serde_json::from_str(&content).map_err(|e| e.to_string())?;

        let mut changed = false;

        if settings.game_dir.is_empty() {
            if let Some(path) = locate_pizza_tower() {
                settings.game_dir = path;
                changed = true;
            }
        }

        if settings.game_data_dir.is_empty() {
            if let Some(path) = locate_game_data_dir() {
                settings.game_data_dir = path;
                changed = true;
            }
        }

        if changed {
            let _ = fs::write(
                &config_path,
                serde_json::to_string_pretty(&settings).unwrap(),
            );
        }

        return Ok(settings);
    }

    let game_dir = locate_pizza_tower().unwrap_or_default();
    let game_data_dir = locate_game_data_dir().unwrap_or_default();

    fn default_gmloader_auto_restart() -> bool {
        #[cfg(windows)]
        {
            false
        }
        #[cfg(not(windows))]
        {
            true
        }
    }

    fn default_wine_mode() -> String {
        #[cfg(windows)]
        {
            return String::new();
        }

        #[cfg(not(windows))]
        {
            if find_proton_path(true).is_some() {
                return "proton_experimental".into();
            }

            if find_proton_path(false).is_some() {
                return "proton".into();
            }
            "wine".into()
        }
    }

    let default = Settings {
        theme: "light".to_string(),
        launch_args: Vec::new(),
        game_dir,
        game_data_dir,
        exe_name: "PizzaTower.exe".to_string(),
        gmloader_exe: "GMLoader.exe".to_string(),
        data_target: "data.win".to_string(),
        prepatch: String::new(),
        steam_api: true,
        gmloader_enabled: false,
        gmloader_auto_restart: default_gmloader_auto_restart(),
        discord_rpc: true,
        wine_mode: default_wine_mode(),
        wine_path: String::new(),
        wine_prefix: String::new(),
    };
    fs::write(
        &config_path,
        serde_json::to_string_pretty(&default).unwrap(),
    )
    .map_err(|e| e.to_string())?;

    Ok(default)
}

fn build_command(exe_path: &Path, _settings: &Settings) -> Command {
    #[cfg(windows)]
    {
        Command::new(exe_path)
    }
    #[cfg(not(windows))]
    {
        let is_windows_file = exe_path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| matches!(ext.to_lowercase().as_str(), "exe" | "msi" | "bat" | "cmd"))
            .unwrap_or(false);

        if is_windows_file {
            let (runner, extra_args, env_vars) = resolve_wine_runner(_settings);
            let mut cmd = Command::new(&runner);

            for arg in &extra_args {
                cmd.arg(arg);
            }
            for (k, v) in &env_vars {
                cmd.env(k, v);
            }

            cmd.arg(exe_path);
            cmd
        } else {
            let _ = ensure_executable(exe_path);
            Command::new(exe_path)
        }
    }
}

#[cfg(not(windows))]
fn ensure_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    let mut perms = metadata.permissions();
    let mode = perms.mode();

    if mode & 0o111 == 0 {
        perms.set_mode(mode | 0o755);
        fs::set_permissions(path, perms).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(not(windows))]
fn resolve_wine_runner(
    settings: &Settings,
) -> (
    String,
    Vec<String>,
    std::collections::HashMap<String, String>,
) {
    let mut env_vars = std::collections::HashMap::new();

    // WINEPREFIX custom
    if !settings.wine_prefix.is_empty() {
        env_vars.insert("WINEPREFIX".into(), settings.wine_prefix.clone());
    }

    match settings.wine_mode.as_str() {
        "proton" | "proton_experimental" => {
            let experimental = settings.wine_mode == "proton_experimental";
            if let Some(proton_path) = find_proton_path(experimental) {
                // Proton a besoin de ces deux variables pour fonctionner
                let compat_data = if !settings.wine_prefix.is_empty() {
                    settings.wine_prefix.clone()
                } else {
                    // Fallback : dossier compatdata de Steam pour Pizza Tower
                    steamlocate::SteamDir::locate()
                        .ok()
                        .and_then(|s| s.find_app(2231450).ok().flatten())
                        .map(|(_, lib)| {
                            lib.path()
                                .join("steamapps")
                                .join("compatdata")
                                .join("2231450")
                                .to_string_lossy()
                                .to_string()
                        })
                        .unwrap_or_else(|| {
                            std::env::var("HOME").unwrap_or_default()
                                + "/.steam/steam/steamapps/compatdata/2231450"
                        })
                };

                let client_path = steamlocate::SteamDir::locate()
                    .ok()
                    .map(|s| s.path().to_string_lossy().to_string())
                    .unwrap_or_else(|| std::env::var("HOME").unwrap_or_default() + "/.steam/steam");

                env_vars.insert("STEAM_COMPAT_DATA_PATH".into(), compat_data);
                env_vars.insert("STEAM_COMPAT_CLIENT_INSTALL_PATH".into(), client_path);

                if std::path::Path::new(&proton_path).is_file() {
                    return (proton_path, vec!["run".into()], env_vars);
                } else {
                    return ("python3".into(), vec![proton_path, "run".into()], env_vars);
                }
            }
            // fallback wine
            ("wine".into(), vec![], env_vars)
        }
        "custom" if !settings.wine_path.is_empty() => {
            (settings.wine_path.clone(), vec![], env_vars)
        }
        _ => ("wine".into(), vec![], env_vars),
    }
}

#[cfg(not(windows))]
fn find_proton_path(experimental: bool) -> Option<String> {
    let steam_dir = steamlocate::SteamDir::locate().ok()?;
    let app_id = if experimental { 1493710u32 } else { 1245040u32 };

    if let Ok(Some((_, lib))) = steam_dir.find_app(app_id) {
        let common = lib.path().join("steamapps").join("common");
        // Cherche n'importe quel dossier Proton dans common
        if let Ok(entries) = fs::read_dir(&common) {
            for entry in entries.filter_map(|e| e.ok()) {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                let is_match = if experimental {
                    name.contains("proton") && name.contains("experimental")
                } else {
                    name.contains("proton") && !name.contains("experimental")
                };
                if is_match {
                    let proton_bin = entry.path().join("proton");
                    if proton_bin.exists() {
                        return Some(proton_bin.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    // Fallback : cherche dans toutes les libs Steam
    let steam_dir = steamlocate::SteamDir::locate().ok()?;
    for lib in steam_dir.libraries().ok()?.filter_map(|l| l.ok()) {
        let common = lib.path().join("steamapps").join("common");
        if let Ok(entries) = fs::read_dir(&common) {
            for entry in entries.filter_map(|e| e.ok()) {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                let is_match = if experimental {
                    name.contains("proton") && name.contains("experimental")
                } else {
                    name.contains("proton") && !name.contains("experimental")
                };
                if is_match {
                    let proton_bin = entry.path().join("proton");
                    if proton_bin.exists() {
                        return Some(proton_bin.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    None
}
fn locate_pizza_tower() -> Option<String> {
    steamlocate::SteamDir::locate()
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
}

fn locate_game_data_dir() -> Option<String> {
    #[cfg(windows)]
    {
        std::env::var("APPDATA").ok().map(|p| {
            Path::new(&p)
                .join("PizzaTower_GM2")
                .to_string_lossy()
                .to_string()
        })
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").ok().map(|p| {
            Path::new(&p)
                .join(".local/share/PizzaTower_GM2")
                .to_string_lossy()
                .to_string()
        })
    }
}

fn exe_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    exe.parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "No exe dir".to_string())
}

fn normalize_path(path: &str) -> PathBuf {
    #[cfg(windows)]
    return PathBuf::from(path.replace("/", "\\"));
    #[cfg(not(windows))]
    return PathBuf::from(path);
}

fn link_or_copy(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // 1. hardlink (no special perms, same volume mandatory)
    if fs::hard_link(src, dst).is_ok() {
        return Ok(());
    }

    // 2. symlink (needs admin or dev mode on Windows)
    #[cfg(windows)]
    if std::os::windows::fs::symlink_file(src, dst).is_ok() {
        return Ok(());
    }
    #[cfg(unix)]
    if std::os::unix::fs::symlink(src, dst).is_ok() {
        return Ok(());
    }

    // 3. mklink fallback (Windows only — junctions for dirs, hardlinks for files, no admin needed)
    #[cfg(windows)]
    {
        let flag = if src.is_dir() { "/J" } else { "/H" };
        if std::process::Command::new("cmd.exe")
            .args(["/c", "mklink", flag])
            .arg(&dst)
            .arg(&src)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return Ok(());
        }
    }

    // 4. copy (universal fallback)
    fs::copy(src, dst).map(|_| ()).map_err(|e| e.to_string())
}

fn writable_base() -> Result<PathBuf, String> {
    let exe = exe_dir()?;
    let test = exe.join(".write_test");
    if fs::write(&test, "").is_ok() {
        let _ = fs::remove_file(&test);
        Ok(exe)
    } else {
        eprintln!("[writable_base] exe dir not writable, falling back to TEMP. Run as admin for better performance.");
        let fallback = std::env::temp_dir().join("CheezyLauncher");
        fs::create_dir_all(&fallback).map_err(|e| e.to_string())?;
        Ok(fallback)
    }
}

#[tauri::command]
fn get_main_dir(folder_name: String) -> Result<String, String> {
    let base = if folder_name.is_empty() {
        exe_dir()?
    } else {
        writable_base()?
    };
    let dir = base.join(&folder_name);
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
    let clean_path = normalize_path(&path);

    let result = match std::env::consts::OS {
        "macos" => Command::new("open").arg(&clean_path).spawn(),
        "windows" => Command::new("explorer").arg(&clean_path).spawn(),
        "linux" => Command::new("xdg-open").arg(&clean_path).spawn(),
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
    let source_path = normalize_path(&source);
    let patch_path = normalize_path(&patch);
    let output_path = normalize_path(&output);

    if !source_path.exists() {
        return Err("Source file not found".into());
    }
    if !patch_path.exists() {
        return Err("Patch file not found".into());
    }
    if !overwrite && output_path.exists() {
        return Err("Output file already exists".into());
    }

    let source_bytes = fs::read(&source_path).map_err(|e| format!("Failed to read source: {}", e))?;
    let patch_bytes = fs::read(&patch_path).map_err(|e| format!("Failed to read patch: {}", e))?;

    let decoded = xdelta3::decode(&patch_bytes, &source_bytes)
        .ok_or_else(|| "xdelta patch failed".to_string())?;

    fs::write(&output_path, &decoded).map_err(|e| format!("Failed to write output: {}", e))
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
    data_target: String,
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

    log("Listing game files...");
    let game_files: Vec<PathBuf> = walkdir::WalkDir::new(game_path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .map(|e| e.path().to_path_buf())
        .collect();

    use std::collections::HashMap;
    let game_files_by_name: HashMap<String, &PathBuf> = game_files
        .iter()
        .map(|p| {
            (
                p.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase(),
                p,
            )
        })
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
            name.ends_with(".xdelta") || name == data_target
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

        let mut langlist = Vec::new();
        let mut langlistfile = Vec::new();

        for entry in &all_entries {
            let file_path = entry.path();
            if file_path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase()
                == "txt"
            {
                let content = fs::read_to_string(file_path).unwrap_or_default();
                for line in content.lines() {
                    let lower = line.to_lowercase();
                    if let Some(idx) = lower.find("lang") {
                        let rest = &lower[idx + 4..].trim_start();
                        if rest.starts_with('=') {
                            let rest = rest[1..].trim_start();
                            if rest.starts_with('"') {
                                if let Some(end_idx) = rest[1..].find('"') {
                                    let val = line[idx + 4..].trim_start()[1..].trim_start()
                                        [1..1 + end_idx]
                                        .to_string();
                                    langlist.push(val);
                                    langlistfile.push(
                                        file_path
                                            .file_stem()
                                            .unwrap()
                                            .to_string_lossy()
                                            .to_string(),
                                    );
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        log("Copying files...");
        for entry in &all_entries {
            let file_path = entry.path();
            let file_name = file_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let extension = file_path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            let mut basename = file_path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            if file_name == "mod.json" || file_name == "settings.json" || extension == "xdelta" {
                continue;
            }

            let mut handled = false;

            if extension == "txt" {
                let content = fs::read_to_string(file_path).unwrap_or_default();
                if content.to_lowercase().contains("lang = ") {
                    let dest = over.join("lang").join(&file_name);
                    fs::create_dir_all(dest.parent().unwrap()).unwrap();
                    fs::copy(file_path, &dest).unwrap();
                    log(&format!("    Copied {} to lang folder", file_name));
                    handled = true;
                } else if basename.to_lowercase().contains("credits") {
                    let dest = over.join(&file_name);
                    fs::create_dir_all(dest.parent().unwrap()).unwrap();
                    fs::copy(file_path, &dest).unwrap();
                    log(&format!("    Copied {} to game folder", file_name));
                    handled = true;
                }
            } else if extension == "win" {
                let dest = over.join("data.win");
                fs::create_dir_all(dest.parent().unwrap()).unwrap();
                fs::copy(file_path, &dest).unwrap();
                log(&format!("    Copied {} as data.win", file_name));
                handled = true;
            } else if extension == "bank" {
                let parent_dir_name = file_path
                    .parent()
                    .unwrap()
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let dest = if parent_dir_name.eq_ignore_ascii_case("Desktop")
                    || parent_dir_name.eq_ignore_ascii_case(mod_name)
                {
                    over.join("sound").join("Desktop").join(&file_name)
                } else {
                    over.join("sound")
                        .join("Desktop")
                        .join(&parent_dir_name)
                        .join(&file_name)
                };
                fs::create_dir_all(dest.parent().unwrap()).unwrap();
                fs::copy(file_path, &dest).unwrap();
                log(&format!("    Copied {} to sound folder", file_name));
                handled = true;
            } else if extension == "dll" || extension == "mp4" {
                let dest = over.join(&file_name);
                fs::create_dir_all(dest.parent().unwrap()).unwrap();
                fs::copy(file_path, &dest).unwrap();
                log(&format!("    Copied {} to game folder", file_name));
                handled = true;
            } else if extension == "ttf" || extension == "otf" {
                let dest = over.join("lang").join("fonts").join(&file_name);
                fs::create_dir_all(dest.parent().unwrap()).unwrap();
                fs::copy(file_path, &dest).unwrap();
                log(&format!("    Copied {} to fonts folder", file_name));
                handled = true;
            } else if extension == "def" {
                let dest = over.join("lang").join(&file_name);
                fs::create_dir_all(dest.parent().unwrap()).unwrap();
                fs::copy(file_path, &dest).unwrap();
                log(&format!("    Copied {} to language folder", file_name));
                handled = true;
            } else if extension == "png" {
                basename = basename
                    .trim_start_matches(|c: char| c.is_ascii_digit())
                    .to_string();

                let mut match_found = None;
                for lang in &langlist {
                    if basename.to_lowercase().starts_with(&lang.to_lowercase()) {
                        match_found = Some(lang.clone());
                        break;
                    }
                }
                if match_found.is_none() {
                    for langf in &langlistfile {
                        if basename.to_lowercase().starts_with(&langf.to_lowercase()) {
                            match_found = Some(langf.clone());
                            break;
                        }
                    }
                }

                if let Some(m) = match_found {
                    basename = m;
                } else {
                    basename = basename
                        .trim_end_matches(|c: char| c.is_ascii_digit())
                        .to_string();
                }

                let mut pngcopied = false;
                let font_list = ["bigfont", "captionfont", "credits", "tutorial"];

                let starts_with_lang = langlist
                    .iter()
                    .any(|x| basename.to_lowercase().starts_with(&x.to_lowercase()));
                let is_font = font_list
                    .iter()
                    .any(|x| basename.to_lowercase().starts_with(x));

                if (langlist.contains(&basename)
                    || langlistfile.contains(&basename)
                    || starts_with_lang)
                    && !is_font
                {
                    let dest = over.join("lang").join("graphics").join(&file_name);
                    fs::create_dir_all(dest.parent().unwrap()).unwrap();
                    fs::copy(file_path, &dest).unwrap();
                    log(&format!("    Copied {} to graphics folder", file_name));
                    pngcopied = true;
                } else {
                    for i in 0..langlist.len() {
                        if !pngcopied
                            && (font_list.contains(&basename.as_str())
                                || basename.ends_with(&format!("_{}", langlist[i]))
                                || basename.ends_with(&format!("_{}", langlistfile[i])))
                        {
                            let dest = over.join("lang").join("fonts").join(&file_name);
                            fs::create_dir_all(dest.parent().unwrap()).unwrap();
                            fs::copy(file_path, &dest).unwrap();
                            log(&format!("    Copied {} to fonts folder", file_name));
                            pngcopied = true;
                            break;
                        }
                    }
                }

                if !pngcopied {
                    log(&format!("    Found {} but doesn't seem to have an attached language file so skipping", file_name));
                }
                handled = true;
            } else if extension == "json" {
                if langlist.contains(&basename) || langlistfile.contains(&basename) {
                    let dest = over.join("lang").join("graphics").join(&file_name);
                    fs::create_dir_all(dest.parent().unwrap()).unwrap();
                    fs::copy(file_path, &dest).unwrap();
                    log(&format!("    Copied {} to graphics folder", file_name));
                } else {
                    log(&format!("    Found {} but doesn't seem to have an attached language file so skipping", file_name));
                }
                handled = true;
            }

            if !handled {
                let rel = file_path
                    .strip_prefix(&mod_base)
                    .map_err(|e| e.to_string())?;
                let dest = over.join(rel);
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::copy(file_path, &dest).map_err(|e| e.to_string())?;
                log(&format!("    Copied: {}", rel.display()));
            }
        }

        if !prepatch.is_empty() {
            log("Finding prepatch...");
            let prepatch_path = exe_dir()?
                .join("prepatches")
                .join(format!("{}.xdelta", prepatch));
            if prepatch_path.exists() {
                log(&format!("Applying prepatch: {}", prepatch));

                let source = game_files_by_name
                    .get("data.win.po")
                    .copied()
                    .or_else(|| {
                        game_files_by_name
                            .get(data_target.to_lowercase().as_str())
                            .copied()
                    })
                    .ok_or_else(|| "data.win not found for prepatch".to_string())?;

                let dest = over.join(&data_target);
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }

                let source_bytes = fs::read(source).map_err(|e| format!("Failed to read prepatch source: {}", e))?;
                let patch_bytes = fs::read(&prepatch_path).map_err(|e| format!("Failed to read prepatch: {}", e))?;
                let decoded = xdelta3::decode(&patch_bytes, &source_bytes)
                    .ok_or_else(|| format!("Prepatch failed: {}", prepatch))?;
                fs::write(&dest, &decoded).map_err(|e| format!("Failed to write prepatch output: {}", e))?;
                log("  ✓ Prepatch applied -> data.win");
            }
        }

        log("Applying patches...");
        let empty_file = over.join("cheezy_empty.tmp");
        let _ = fs::write(&empty_file, "");

        let mut possible_sources: Vec<PathBuf> = Vec::new();
        possible_sources.push(empty_file.clone());
        if over.exists() {
            for ow_entry in walkdir::WalkDir::new(over) {
                if let Ok(entry) = ow_entry {
                    if entry.path().is_file() {
                        possible_sources.push(entry.path().to_path_buf());
                    }
                }
            }
        }
        for game_file in &game_files {
            let po_path = game_file.with_file_name(format!(
                "{}.po",
                game_file.file_name().unwrap_or_default().to_string_lossy()
            ));
            if po_path.exists() {
                possible_sources.push(po_path);
            }
            possible_sources.push(game_file.clone());
        }

        let mut unique_sources = Vec::new();
        let mut seen_sources = std::collections::HashSet::new();
        for src in possible_sources {
            if seen_sources.insert(src.clone()) {
                unique_sources.push(src);
            }
        }

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

            let expected_stem = entry
                .path()
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            let mut intended_dest_rel = PathBuf::from(&data_target);

            for game_file in &game_files {
                if let Ok(rel) = game_file.strip_prefix(game_path) {
                    if rel
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_lowercase()
                        == expected_stem
                    {
                        intended_dest_rel = rel.to_path_buf();
                        break;
                    }
                }
            }

            let dest = over.join(&intended_dest_rel);
            let mut patched = false;

            let mut smart_candidates = Vec::new();
            smart_candidates.push(empty_file.clone());
            if dest.exists() {
                smart_candidates.push(dest.clone());
            }

            let game_dest = game_path.join(&intended_dest_rel);
            let po_dest = game_dest.with_file_name(format!(
                "{}.po",
                game_dest.file_name().unwrap_or_default().to_string_lossy()
            ));
            if po_dest.exists() {
                smart_candidates.push(po_dest);
            }
            if game_dest.exists() {
                smart_candidates.push(game_dest.clone());
            }

            let data_win_path = game_path.join(&data_target);
            if data_win_path.exists() {
                smart_candidates.push(data_win_path);
            }

            for src in &unique_sources {
                if !smart_candidates.contains(src) {
                    smart_candidates.push(src.clone());
                }
            }

            let patch_bytes = fs::read(entry.path()).map_err(|e| format!("Failed to read patch: {}", e))?;
            for source in &smart_candidates {
                let source_bytes = match fs::read(source) {
                    Ok(b) => b,
                    Err(_) => continue,
                };

                if let Some(decoded) = xdelta3::decode(&patch_bytes, &source_bytes) {
                    if let Some(p) = dest.parent() {
                        let _ = fs::create_dir_all(p);
                    }
                    if fs::write(&dest, &decoded).is_ok() {
                        log(&format!("    ✓ Patched -> {}", intended_dest_rel.display()));
                        patched = true;
                        break;
                    }
                }
            }

            if !patched {
                let msg = format!("    ✗ No source found for: {}", file_name);
                log(&msg);
                if empty_file.exists() {
                    let _ = fs::remove_file(&empty_file);
                }
                return Err(msg);
            }
        }
        if empty_file.exists() {
            let _ = fs::remove_file(&empty_file);
        }
    }

    let src = over.join(&data_target);
    let dst = over.join("data.win");

    if data_target.to_lowercase() != "data.win" {
        let src = game_path.join(&data_target);
        let dst = over.join(&data_target);

        if src.exists() {
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(&src, &dst).map_err(|e| e.to_string())?;
        }
    }
    if src.exists() && src != dst {
        if dst.exists() {
            fs::remove_file(&dst).map_err(|e| e.to_string())?;
        }
        fs::rename(&src, &dst).map_err(|e| e.to_string())?;
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

#[tauri::command]
fn mount_vfs(
    game_dir: String,
    overwrite_path: String,
    vfs_root: String,
    steam_api: bool,
    gmloader_enabled: bool,
) -> Result<(), String> {
    let settings = get_settings()?;
    let game = Path::new(&game_dir);
    let over = Path::new(&overwrite_path);
    let root = Path::new(&vfs_root);

    if root.exists() {
        fs::remove_dir_all(root).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;

    use std::collections::HashSet;
    let overwrite_files: HashSet<PathBuf> = if over.exists() {
        walkdir::WalkDir::new(over)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_file())
            .filter_map(|e| e.path().strip_prefix(over).ok().map(|r| r.to_path_buf()))
            .collect()
    } else {
        HashSet::new()
    };

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

            if !steam_api {
                let fname = entry
                    .path()
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase();
                if fname == "steam_api64.dll"
                    || fname == "steam_api.dll"
                    || fname == "steamworks_x64.dll"
                    || fname == "steamworks.dll"
                {
                    continue;
                }
            }

            if overwrite_files.contains(rel) {
                let over_src = over.join(rel);
                link_or_copy(&over_src, &dest)?;
                continue;
            }

            link_or_copy(entry.path(), &dest)?;
        }
    }
    for rel in &overwrite_files {
        let dest = root.join(rel);
        if dest.exists() {
            continue;
        }
        let over_src = over.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        link_or_copy(&over_src, &dest)?;
    }

    if gmloader_enabled {
        let data_win_dest = over.join("data.win");

        if !data_win_dest.exists() {
            let data_win_src = game.join("data.win");

            if data_win_src.exists() {
                fs::create_dir_all(data_win_dest.parent().unwrap()).map_err(|e| e.to_string())?;
                fs::copy(&data_win_src, &data_win_dest).map_err(|e| e.to_string())?;
            }
        }

        let vfs_data_win_dest = root.join("data.win");

        if vfs_data_win_dest.exists() {
            fs::remove_file(&vfs_data_win_dest).map_err(|e| e.to_string())?;
        }

        link_or_copy(&data_win_dest, &vfs_data_win_dest)?;

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
                        let auto_restart = settings.gmloader_auto_restart;
                        content = content
                            .lines()
                            .map(|line| {
                                if line.starts_with("SupportedDataHash=") {
                                    format!("SupportedDataHash={}", hash)
                                } else if line.starts_with("CheckHash=") {
                                    "CheckHash=false".to_string()
                                } else if line.starts_with("AutoGameStart=") {
                                    format!(
                                        "AutoGameStart={}",
                                        if auto_restart { "true" } else { "false" }
                                    )
                                } else if line.starts_with("GameData=") {
                                    "GameData=data.win".to_string()
                                } else {
                                    line.to_string()
                                }
                            })
                            .collect::<Vec<_>>()
                            .join("\r\n");
                    }

                    let overwrite_ini_path = over.join("GMLoader.ini");
                    fs::write(&overwrite_ini_path, &content).map_err(|e| e.to_string())?;

                    let vfs_ini_dest = root.join("GMLoader.ini");
                    link_or_copy(&overwrite_ini_path, &vfs_ini_dest)?;
                    continue;
                }

                let dest = root.join(rel);
                if entry.path().is_dir() {
                    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
                } else {
                    if let Some(parent) = dest.parent() {
                        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                    link_or_copy(entry.path(), &dest)?;
                }
            }
        }
    }

    fs::write(
        root.join("steam_appid.txt"),
        if steam_api { "2231450" } else { "0" },
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn unmount_vfs(vfs_root: String) -> Result<(), String> {
    let root = Path::new(&vfs_root);

    if root.exists() {
        let log_src = root.join("GMLoader.log");

        if log_src.exists() {
            let exe_dir = exe_dir()?;
            let log_dst = exe_dir.join("GMLoader.log");

            match fs::rename(&log_src, &log_dst) {
                Ok(_) => {
                    println!("GMLoader.log moved to exe directory");
                }
                Err(_) => {
                    fs::copy(&log_src, &log_dst).map_err(|e| e.to_string())?;
                    println!("GMLoader.log copied to exe directory");
                }
            }
        }

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
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        if s.operation_running {
            return Err("An operation is already in progress".into());
        }
        s.operation_running = true;
    }
    let settings = get_settings()?;

    let exe_path = Path::new(&vfs_root).join(&exe_name);
    if !exe_path.exists() {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.operation_running = false;
        return Err(format!("Exe not found: {:?}", exe_path));
    }

    let steam_helper_child = if exe_name == settings.exe_name && settings.steam_api {
        let helper_name = if cfg!(windows) {
            "cheezylauncher-steamhelper.exe"
        } else {
            "cheezylauncher-steamhelper"
        };

        let helper_path = exe_dir().ok().and_then(|d| {
            let path = d.join("deps").join(&helper_name);
            if path.exists() { Some(path) } else { None }
        });

        if let Some(path) = helper_path {
            #[cfg(not(windows))]
            let _ = ensure_executable(&path);

            let mut cmd = Command::new(&path);
            cmd.arg(&vfs_root)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .stdin(Stdio::null());

            #[cfg(not(windows))]
            {
                // Sur Linux : libsteam_api.so natif depuis le dossier Steam linux64
                if let Ok(steam_dir) = steamlocate::SteamDir::locate() {
                    let lib_path = steam_dir.path().join("linux64");
                    if lib_path.exists() {
                        cmd.env("LD_LIBRARY_PATH", lib_path);
                    }
                }
            }

            cmd.spawn().ok()
        } else {
            eprintln!("[cheezy-steam-helper] binary not found: {}", helper_name);
            None
        }
    } else {
        None
    };

    let mut child = {
        let mut cmd = build_command(&exe_path, &settings);
        cmd.current_dir(&vfs_root)
            .args(&launch_args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::null());

        #[cfg(windows)]
        cmd.creation_flags(0x08000000);

        cmd.spawn().map_err(|e| {
            let mut s = state.lock().unwrap();
            s.operation_running = false;
            e.to_string()
        })?
    };

    let pid = child.id();
    {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.game_pid = Some(pid);
    }

    if let Some(stdout) = child.stdout.take() {
        let app_handle_out = app_handle.clone();
        let exe_name_out = exe_name.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let _ = app_handle_out.emit(
                        "process-output",
                        serde_json::json!({ "exe": exe_name_out, "line": line, "stream": "stdout" }),
                    );
                }
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app_handle_err = app_handle.clone();
        let exe_name_err = exe_name.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let _ = app_handle_err.emit(
                        "process-output",
                        serde_json::json!({ "exe": exe_name_err, "line": line, "stream": "stderr" }),
                    );
                }
            }
        });
    }

    let state_clone = Arc::clone(&state);
    std::thread::spawn(move || {
        let _ = child.wait();
        if let Some(mut helper) = steam_helper_child {
            let _ = helper.kill();
            let _ = helper.wait();
        }
        let mut s = state_clone.lock().unwrap();
        s.operation_running = false;
        s.game_pid = None;
        let _ = app_handle.emit("process-ended", &exe_name);
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
async fn download_and_install_mod(
    url: String,
    mod_name: String,
    mods_path: String,
    file_name: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    use std::io::Cursor;

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let total_size = response.content_length().unwrap_or(0);

    let mut file_bytes = Vec::new();
    let mut downloaded: u64 = 0;
    let mut last_emit = 0;
    let total_mb = total_size as f64 / 1_048_576.0;

    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        file_bytes.extend_from_slice(&chunk);
        downloaded += chunk.len() as u64;

        if total_size > 0 {
            let percent = (downloaded as f64 / total_size as f64 * 100.0) as u8;
            if percent >= last_emit + 2 || percent == 100 {
                last_emit = percent;
                let downloaded_mb = downloaded as f64 / 1_048_576.0;
                let payload = format!(
                    r#"{{"file_name": "{}", "percent": {}, "downloaded_mb": {:.2}, "total_mb": {:.2}}}"#,
                    file_name, percent, downloaded_mb, total_mb
                );
                let _ = app_handle.emit("download-progress", payload);
            }
        }
    }

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
        extract_rar(&tmp_path, &mod_dir)?;
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
    } else if archive_type == "7z" {
        let tmp_path = Path::new(&mods_path).join(&file_name);
        fs::write(&tmp_path, &file_bytes).map_err(|e| e.to_string())?;
        sevenz_rust::decompress_file(&tmp_path, &mod_dir).map_err(|e| e.to_string())?;
        fs::remove_file(&tmp_path).map_err(|e| e.to_string())?;
    } else if archive_type == "rar" {
        let tmp_path = Path::new(&mods_path).join(&file_name);
        fs::write(&tmp_path, &file_bytes).map_err(|e| e.to_string())?;
        extract_rar(&tmp_path, &mod_dir)?;
        fs::remove_file(&tmp_path).map_err(|e| e.to_string())?;
    } else {
        let out_path = mod_dir.join(&file_name);
        fs::write(&out_path, &file_bytes).map_err(|e| e.to_string())?;
    }

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
    const APP_ID: u32 = 2231450;

    // Steam / Proton (Linux + aussi possible Windows Steam setup)
    if let Ok(steam_dir) = steamlocate::SteamDir::locate() {
        if let Ok(Some((_app, lib))) = steam_dir.find_app(APP_ID) {
            let path = lib
                .path()
                .join("steamapps")
                .join("compatdata")
                .join(APP_ID.to_string())
                .join("pfx")
                .join("drive_c")
                .join("users")
                .join("steamuser")
                .join("AppData")
                .join("Roaming")
                .join("PizzaTower_GM2");

            return Ok(path.to_string_lossy().to_string());
        }
    }

    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let path = Path::new(&appdata).join("PizzaTower_GM2");
            return Ok(path.to_string_lossy().to_string());
        }
    }

    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME") {
            let path = Path::new(&home).join(".local/share/PizzaTower_GM2");

            return Ok(path.to_string_lossy().to_string());
        }
    }

    Err("Could not find game data directory".to_string())
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
fn list_files_by_ext(folder: String, ext: String) -> Result<Vec<String>, String> {
    let dir = exe_dir()?.join(&folder);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        return Ok(vec![]);
    }
    Ok(fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|x| x.to_string_lossy() == ext)
                .unwrap_or(false)
        })
        .filter_map(|e| {
            e.path()
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
        })
        .collect())
}

#[tauri::command]
fn is_process_running(name: String, state: State<'_, SysState>) -> bool {
    let mut sys = match state.lock() {
        Ok(s) => s,
        Err(_) => return false,
    };
    sys.refresh_processes(ProcessesToUpdate::All, false);
    let target = name.to_lowercase();
    sys.processes()
        .values()
        .any(|p| p.name().to_string_lossy().to_lowercase().contains(&target))
}

#[tauri::command]
fn kill_process(name: String, state: State<'_, SysState>) -> usize {
    let mut sys = match state.lock() {
        Ok(s) => s,
        Err(_) => return 0,
    };
    sys.refresh_processes(ProcessesToUpdate::All, false);
    let target = name.to_lowercase();
    let mut killed = 0;
    for process in sys.processes().values() {
        if process.name().to_string_lossy().to_lowercase() == target {
            if process.kill() {
                killed += 1;
            }
        }
    }
    killed
}

// Plugins Section

#[derive(Serialize, Deserialize, Clone)]
struct PluginAuthor {
    name: String,
    #[serde(default)]
    url: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct PluginManifest {
    id: String,
    name: String,
    version: String,
    authors: Vec<PluginAuthor>,
    #[serde(default)]
    description: String,
    #[serde(default)]
    enabled: bool,
}

#[tauri::command]
fn list_plugins() -> Result<Vec<PluginManifest>, String> {
    let plugins_dir = exe_dir()?.join("plugins");
    if !plugins_dir.exists() {
        fs::create_dir_all(&plugins_dir).map_err(|e| e.to_string())?;
        return Ok(vec![]);
    }

    let enabled_path = plugins_dir.join("enabled.json");
    let enabled_ids: Vec<String> = if enabled_path.exists() {
        serde_json::from_str(&fs::read_to_string(&enabled_path).unwrap_or_default())
            .unwrap_or_default()
    } else {
        vec![]
    };

    let mut manifests = vec![];
    for entry in fs::read_dir(&plugins_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.path().is_dir() {
            continue;
        }
        let manifest_path = entry.path().join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }
        let content = fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
        let mut manifest: PluginManifest =
            serde_json::from_str(&content).map_err(|e| e.to_string())?;
        manifest.enabled = enabled_ids.contains(&manifest.id);
        manifests.push(manifest);
    }
    Ok(manifests)
}

fn get_plugin_dir(plugin_id: &str) -> PathBuf {
    exe_dir().unwrap().join("plugins").join(plugin_id)
}

#[tauri::command]
fn set_plugin_enabled(plugin_id: String, enabled: bool) -> Result<(), String> {
    let plugins_dir = exe_dir()?.join("plugins");
    let enabled_path = plugins_dir.join("enabled.json");
    let mut ids: Vec<String> = if enabled_path.exists() {
        serde_json::from_str(&fs::read_to_string(&enabled_path).unwrap_or_default())
            .unwrap_or_default()
    } else {
        vec![]
    };

    if enabled {
        if !ids.contains(&plugin_id) {
            ids.push(plugin_id);
        }
    } else {
        ids.retain(|id| id != &plugin_id);
    }

    fs::write(&enabled_path, serde_json::to_string_pretty(&ids).unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_plugin_script(plugin_id: String) -> Result<String, String> {
    let dir = get_plugin_dir(&plugin_id);

    let candidates = ["index.tsx", "index.ts", "index.jsx", "index.js"];

    for file in candidates {
        let path = dir.join(file);
        if path.exists() {
            return std::fs::read_to_string(path).map_err(|e| e.to_string());
        }
    }

    Err("No entry file found".into())
}

#[tauri::command]
async fn download_gmloader(
    file_name: String,
    download_url: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    use std::io::Cursor;

    let dest_dir = exe_dir()?.join("deps").join("GMLoader");
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| e.to_string())?;

    let mut response = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let total_size = response.content_length().unwrap_or(0);
    let mut file_bytes = Vec::new();
    let mut downloaded: u64 = 0;
    let mut last_emit: u8 = 0;
    let total_mb = total_size as f64 / 1_048_576.0;

    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        file_bytes.extend_from_slice(&chunk);
        downloaded += chunk.len() as u64;

        if total_size > 0 {
            let percent = (downloaded as f64 / total_size as f64 * 100.0) as u8;
            if percent >= last_emit + 2 || percent == 100 {
                last_emit = percent;
                let downloaded_mb = downloaded as f64 / 1_048_576.0;
                let payload = format!(
                    r#"{{"file_name": "{}", "percent": {}, "downloaded_mb": {:.2}, "total_mb": {:.2}}}"#,
                    file_name, percent, downloaded_mb, total_mb
                );
                let _ = app_handle.emit("gmloader-download-progress", payload);
            }
        }
    }

    let archive_type = detect_archive_type(&file_bytes);

    if archive_type == "zip" {
        let cursor = Cursor::new(file_bytes);
        let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
        for i in 0..archive.len() {
            let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
            let out_path = dest_dir.join(file.name());
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
        let tmp_path = dest_dir.join(&file_name);
        fs::write(&tmp_path, &file_bytes).map_err(|e| e.to_string())?;
        sevenz_rust::decompress_file(&tmp_path, &dest_dir).map_err(|e| e.to_string())?;
        fs::remove_file(&tmp_path).map_err(|e| e.to_string())?;
    } else if archive_type == "rar" {
        let tmp_path = dest_dir.join(&file_name);
        fs::write(&tmp_path, &file_bytes).map_err(|e| e.to_string())?;
        extract_rar(&tmp_path, &dest_dir)?;
        fs::remove_file(&tmp_path).map_err(|e| e.to_string())?;
    } else {
        // Fichier brut (ex: .exe directement)
        let out_path = dest_dir.join(&file_name);
        fs::write(&out_path, &file_bytes).map_err(|e| e.to_string())?;
    }

    // Aplatir si l'archive contenait un seul sous-dossier
    let entries: Vec<_> = fs::read_dir(&dest_dir)
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
            let dest = dest_dir.join(rel);
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
fn gmloader_installed() -> Result<bool, String> {
    let dir = exe_dir()?.join("deps").join("GMLoader");
    if !dir.exists() {
        return Ok(false);
    }
    // Considéré installé si le dossier contient au moins un fichier
    let has_file = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .any(|e| e.path().is_file());
    Ok(has_file)
}

pub fn run() {
    let shared_state: SharedState = Arc::new(Mutex::new(AppState::default()));
    let sys_state: SysState = Arc::new(Mutex::new(System::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_drpc::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(shared_state)
        .manage(sys_state)
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
            download_and_install_mod,
            install_local_mod,
            fetch_file,
            detect_game_dir,
            detect_game_data_dir,
            get_mod_base_dir,
            flatten_mod_dir,
            list_files_by_ext,
            is_process_running,
            kill_process,
            // plugins
            list_plugins,
            set_plugin_enabled,
            read_plugin_script,
            // gmloader
            download_gmloader,
            gmloader_installed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
