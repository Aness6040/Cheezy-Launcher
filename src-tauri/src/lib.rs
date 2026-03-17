use std::fs;
use std::process::Command;
use tauri_plugin_single_instance::init as single_instance;
use tauri::Manager;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize)]
struct Settings {
    theme: String,
}

#[tauri::command]
fn get_settings() -> Result<Settings, String> {
    let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe_path.parent().ok_or("No exe dir")?;

    let config_path: PathBuf = exe_dir.join("settings.json");

    if !config_path.exists() {
        let default_settings = Settings {
            theme: "light".to_string(),
        };
        fs::write(&config_path, serde_json::to_string_pretty(&default_settings).unwrap())
            .map_err(|e| e.to_string())?;
    }
    let content = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    let settings: Settings = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    Ok(settings)
}

#[tauri::command]
fn get_main_dir(folder_name: String) -> Result<String, String> {
    let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe_path.parent().ok_or("Impossible de trouver le dossier parent")?;
    let target_dir = exe_dir.join(&folder_name);
    if !target_dir.exists() {
        fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
    }
    Ok(target_dir.to_string_lossy().to_string())
}

#[tauri::command]
fn list_mods(mods_path: String) -> Result<Vec<String>, String> {
    let entries = fs::read_dir(&mods_path)
        .map_err(|e| e.to_string())?;

    let folders: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();

    Ok(folders)
}

#[tauri::command]
fn run_file(path: String) -> Result<(), String> {
    Command::new(path)
        .spawn()
        .map_err(|e: std::io::Error| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn add_item(path: String, is_dir: bool) -> Result<(), String> {
    if is_dir {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    } else {
        std::fs::File::create(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn remove_item(path: String) -> Result<(), String> {
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    } else {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn rename_item(old_path: String, new_path: String) -> Result<(), String> {
    std::fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn read_item(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn edit_item(path: String, content: String) -> Result<(), String> {
    use std::io::Write;

    let mut file = std::fs::File::create(&path)
        .map_err(|e| e.to_string())?;

    file.write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn move_item(src_path: String, dest_path: String) -> Result<(), String> {
    std::fs::rename(&src_path, &dest_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_item(path: String) -> Result<(), String> {
    use std::process::Command;
    use std::env::consts::OS;

    let result = match OS {
        "macos" => Command::new("open")
            .arg(&path)
            .spawn(),
        "windows" => Command::new("explorer")
            .arg(&path)
            .spawn(),
        "linux" => Command::new("xdg-open")
            .arg(&path)
            .spawn(),
        _ => return Err("Unsupported OS".into()),
    };

    result.map_err(|e| e.to_string())?;
    Ok(())
}

fn get_xdelta_path() -> String {
    let exe_dir = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();

    let xdelta = exe_dir.join("deps").join("xdelta3.exe");

    xdelta.to_string_lossy().to_string()
}

#[tauri::command]
fn apply_xdelta_patch(source: String, patch: String, output: String) -> Result<(), String> {
    let xdelta_path = get_xdelta_path();

    let status = std::process::Command::new(xdelta_path)
        .args(&["-d", "-s", &source, &patch, &output])
        .status()
        .map_err(|e| e.to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Error Xdelta, code: {}", status.code().unwrap_or(-1)))
    }
}

#[tauri::command]
fn apply_overwrite(overwrite_path: String, target_path: String) -> Result<(), String> {
    let src = std::path::Path::new(&overwrite_path);
    let dst = std::path::Path::new(&target_path);

    for entry in walkdir::WalkDir::new(src) {
        let entry = entry.map_err(|e| e.to_string())?;
        let rel = entry.path().strip_prefix(src).map_err(|e| e.to_string())?;
        let dest = dst.join(rel);

        if entry.path().is_dir() {
            fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        } else {
            fs::copy(entry.path(), &dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn remove_overwrite(overwrite_path: String, target_path: String) -> Result<(), String> {
    let src = std::path::Path::new(&overwrite_path);
    let dst = std::path::Path::new(&target_path);

    for entry in walkdir::WalkDir::new(src) {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().is_file() {
            let rel = entry.path().strip_prefix(src).map_err(|e| e.to_string())?;
            let target_file = dst.join(rel);
            if target_file.exists() {
                fs::remove_file(target_file).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(single_instance(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_focus().unwrap();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_settings, get_main_dir, list_mods, run_file, add_item, remove_item, rename_item, edit_item, read_item, move_item, open_item, apply_xdelta_patch, apply_overwrite, remove_overwrite])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}