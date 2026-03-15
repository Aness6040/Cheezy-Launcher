use std::fs;
use std::process::Command;

#[tauri::command]
fn get_mods_dir() -> Result<String, String> {
    let exe_path = std::env::current_exe()
        .map_err(|e| e.to_string())?;

    let exe_dir = exe_path
        .parent()
        .ok_or("Impossible de trouver le dossier parent")?;

    let mods_dir = exe_dir.join("mods");

    if !mods_dir.exists() {
        fs::create_dir_all(&mods_dir)
            .map_err(|e| e.to_string())?;
    }

    Ok(mods_dir.to_string_lossy().to_string())
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
fn move_item(src_path: String, dest_path: String) -> Result<(), String> {
    std::fs::rename(&src_path, &dest_path).map_err(|e| e.to_string())?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_mods_dir, list_mods, run_file, add_item, remove_item, rename_item, move_item, apply_xdelta_patch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}