use std::fs;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_mods_dir, list_mods])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}