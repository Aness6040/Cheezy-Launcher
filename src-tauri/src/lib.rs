use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
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
}

#[tauri::command]
fn get_settings() -> Result<Settings, String> {
  let exe_dir = exe_dir()?;
  let config_path = exe_dir.join("settings.json");
  if !config_path.exists() {
    let default = Settings {
    theme: "light".to_string(),
    launch_args: Vec::new(),
    };
    fs::write(
      &config_path,
      serde_json::to_string_pretty(&default).unwrap(),
    )
    .map_err(|e| e.to_string())?;
  }
  let content = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
  serde_json::from_str(&content).map_err(|e| e.to_string())
}

fn exe_dir() -> Result<PathBuf, String> {
  let exe = std::env::current_exe().map_err(|e| e.to_string())?;
  exe
    .parent()
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
  Ok(
    entries
      .filter_map(|e| e.ok())
      .filter(|e| e.path().is_dir())
      .filter_map(|e| e.file_name().into_string().ok())
      .collect(),
  )
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
  cmd
    .arg("-s")
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
  app_handle: tauri::AppHandle,
) -> Result<(), String> {
  let log = |msg: &str| {
    let _ = app_handle.emit("prepare-log", msg.to_string());
  };

  let overwrite_dir = Path::new(&overwrite_path);
  let game_path = Path::new(&game_dir);

  log("Clearing overwrite folder...");
  if overwrite_dir.exists() {
    fs::remove_dir_all(overwrite_dir).map_err(|e| e.to_string())?;
  }
  fs::create_dir_all(overwrite_dir).map_err(|e| e.to_string())?;

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

    let root_files: Vec<_> =
      root_entries.iter().filter(|e| e.path().is_file()).collect();

    let root_dirs: Vec<_> =
      root_entries.iter().filter(|e| e.path().is_dir()).collect();

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
      let dest = overwrite_dir.join(rel);
      if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
      }
      fs::copy(entry.path(), &dest).map_err(|e| e.to_string())?;
      log(&format!("    Copied: {}", rel.display()));
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

      if overwrite_dir.exists() {
        for ow_entry in walkdir::WalkDir::new(overwrite_dir) {
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
        let (dest, use_tmp) = if source.starts_with(overwrite_dir) {
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
          (overwrite_dir.join(rel), false)
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
            dest.strip_prefix(overwrite_dir).unwrap_or(&dest).display()
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

  log("Overwrite ready ✓");
  Ok(())
}

fn run_xdelta(
  xdelta: &Path,
  source: &Path,
  patch: &Path,
  output: &Path,
) -> Result<(), String> {
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

fn find_file_recursive(
  dir: &Path,
  name: &str,
) -> Result<Option<PathBuf>, String> {
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

fn resolve_output_path(
  base: &Path,
  rel_parent: &Path,
  file_name: &str,
) -> PathBuf {
  base.join(rel_parent).join(file_name)
}

#[tauri::command]
fn mount_vfs(
  game_dir: String,
  overwrite_path: String,
  vfs_root: String,
) -> Result<(), String> {
  let game = Path::new(&game_dir);
  let over = Path::new(&overwrite_path);
  let root = Path::new(&vfs_root);

  // Nettoyer et recréer vfs_root
  if root.exists() {
    fs::remove_dir_all(root).map_err(|e| e.to_string())?;
  }
  fs::create_dir_all(root).map_err(|e| e.to_string())?;

  // 1. Hardlinks de tous les fichiers du jeu vers vfs_root
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
      // Hardlink : pas de copie physique, même inode
      #[cfg(windows)]
      std::os::windows::fs::symlink_file(entry.path(), &dest)
        .or_else(|_| fs::copy(entry.path(), &dest).map(|_| ()))
        .map_err(|e| e.to_string())?;
      #[cfg(not(windows))]
      std::os::unix::fs::symlink(entry.path(), &dest)
        .map_err(|e| e.to_string())?;
    }
  }

  // 2. Écraser avec les fichiers de overwrite/ (copie réelle, priorité)
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
    // Supprimer le symlink existant puis copier le vrai fichier
    if dest.exists() {
      fs::remove_file(&dest).map_err(|e| e.to_string())?;
    }
    fs::copy(entry.path(), &dest).map_err(|e| e.to_string())?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let shared_state: SharedState = Arc::new(Mutex::new(AppState::default()));

  tauri::Builder::default()
    .manage(shared_state)
    .plugin(single_instance(|app, _argv, _cwd| {
      if let Some(w) = app.get_webview_window("main") {
        w.set_focus().unwrap();
      }
    }))
    .plugin(tauri_plugin_opener::init())
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
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
