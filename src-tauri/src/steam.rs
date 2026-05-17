use prost::Message;
use std::path::{Path, PathBuf};
use tauri::Emitter;
use steamroom::client::PROTOCOL_VERSION;
use steamroom::depot::DepotId;
use steamroom::depot::ManifestId;

async fn download_file_v2(
    depot_id: DepotId,
    file: &steamroom::depot::manifest::ManifestFile,
    depot_key: &steamroom::depot::DepotKey,
    fetcher: &std::sync::Arc<impl steamroom_client::download::ChunkFetcher>,
) -> Result<Vec<u8>, String> {
    let mut file_data = Vec::new();
    let mut pos = 0usize;
    for chunk_meta in &file.chunks {
        let mut last_err = None;
        for attempt in 0..5 {
            match fetcher.fetch_chunk(depot_id, &chunk_meta.id).await {
                Ok(raw) => {
                    match steamroom::depot::chunk::process_chunk(
                        &raw, depot_key, chunk_meta.uncompressed_size, chunk_meta.checksum,
                    ) {
                        Ok(processed) => {
                            let offset = chunk_meta.offset.unwrap_or(pos as u64) as usize;
                            let end = offset + processed.len();
                            if end > file_data.len() {
                                file_data.resize(end, 0);
                            }
                            file_data[offset..end].copy_from_slice(&processed);
                            pos = end;
                            last_err = None;
                            break;
                        }
                        Err(e) => {
                            last_err = Some(format!("chunk process error: {}", e));
                        }
                    }
                }
                Err(e) => {
                    last_err = Some(format!("chunk fetch error: {}", e));
                }
            }
            let wait_ms = 500u64 * (1u64 << attempt);
            tokio::time::sleep(std::time::Duration::from_millis(wait_ms.min(8000))).await;
        }
        if let Some(e) = last_err {
            return Err(format!("{}: {}", file.filename, e));
        }
    }

    if let Some(expected_sha) = file.sha_content.as_ref() {
        let actual_sha = steamroom::util::checksum::Sha1Hash::compute(&file_data).0;
        if actual_sha != *expected_sha {
            return Err(format!("SHA1 mismatch for {} after download", file.filename));
        }
    }

    Ok(file_data)
}

#[tauri::command]
pub async fn verify_integrity_files(
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    use steamroom::apps::AccessToken;
    use steamroom::cdn::CdnClient;
    use steamroom::client::msg::ClientMsg;
    use steamroom::client::SteamClient;
    use steamroom::client::LoggedIn;
    use steamroom::connection;
    use steamroom::depot::manifest::DepotManifest;
    use steamroom::depot::AppId;
    use steamroom::depot::CellId;
    use steamroom::messages::EMsg;
    use steamroom::transport::websocket::WebSocketTransport;
    use steamroom::types::key_value::KvValue;

    let log = |msg: &str| {
        let _ = app_handle.emit("verify-log", msg.to_string());
    };

    log("Starting integrity verification...");

    let game_dir = super::detect_game_dir()?;
    log(&format!("Game directory: {}", game_dir));
    let app_id = AppId(2231450);

    log("Discovering Steam CM servers...");
    let servers = connection::CmServer::fetch().await.map_err(|e| e.to_string())?;
    let ws_server = servers
        .iter()
        .find(|s| s.protocol == connection::Protocol::WebSocket)
        .ok_or_else(|| "No WebSocket CM server found".to_string())?;

    async fn connect_and_login(
        ws_server: &connection::CmServer,
        logon: &steamroom::generated::CMsgClientLogon,
        steam_id: u64,
    ) -> Result<SteamClient<LoggedIn>, String> {
        let transport = WebSocketTransport::connect(ws_server)
            .await
            .map_err(|e| e.to_string())?;
        let (client, rx) = SteamClient::connect_ws(transport)
            .await
            .map_err(|e| e.to_string())?;
        let logon_bytes = logon.encode_to_vec();
        let mut msg = ClientMsg::with_body(EMsg::CLIENT_LOGON, &logon_bytes);
        msg.header.steamid = Some(steam_id);
        msg.header.client_sessionid = Some(0);
        let (client, resp) = client.login(msg).await.map_err(|e| e.to_string())?;
        eprintln!(
            "[connect_and_login] login response: steamid={:?}, sessionid={:?}",
            resp.header.steamid,
            resp.header.client_sessionid,
        );
        tokio::spawn(async move {
            while rx.recv().await.is_ok() {}
        });
        Ok(client)
    }

    log("Connecting...");
    let (client, auth_type) = if let Some((username, refresh_token)) = extract_cached_steam_token() {
        log(&format!("Using cached Steam token for user {}", username));
        let (token_logon, token_sid) = build_token_logon(&username, &refresh_token);
        (connect_and_login(ws_server, &token_logon, token_sid).await?, "token")
    } else {
        let diag = extract_steam_token_diag();
        log(&format!("No Steam token found: {}; connecting anonymously", diag));
        let (anon_logon, anon_steam_id) = build_anon_logon();
        (connect_and_login(ws_server, &anon_logon, anon_steam_id).await?, "anonymous")
    };
    log(&format!("Logged in ({})", auth_type));

    log("Getting app info...");
    let tokens = client
        .pics_get_access_tokens(&[app_id])
        .await
        .map_err(|e| e.to_string())?;
    let token = tokens
        .into_iter()
        .next()
        .unwrap_or(AccessToken { app_id, token: 0 });
    let infos = client
        .pics_get_product_info(&[token])
        .await
        .map_err(|e| e.to_string())?;
    let app_info = infos
        .into_iter()
        .next()
        .ok_or_else(|| "No product info".to_string())?;
    let kv_data = app_info
        .kv_data
        .ok_or_else(|| "No KV data".to_string())?;

    let kv = parse_app_kv(&kv_data)?;
    let depots_kv = kv
        .get("depots")
        .ok_or_else(|| "No depots found".to_string())?;

    let depot_ids: Vec<DepotId> = if let KvValue::Children(ref map) = depots_kv.value {
        map.keys()
            .filter_map(|k| k.parse::<u32>().ok().filter(|&id| id > 0).map(DepotId))
            .collect()
    } else {
        return Err("Invalid depots structure".to_string());
    };

    if depot_ids.is_empty() {
        return Err("No depots found for this app".to_string());
    }
    log(&format!("Found {} depot(s)", depot_ids.len()));

    let current_os = if cfg!(windows) { "windows" } else { "linux" };
    let os_filter = |oslist: &str| oslist.split(',').any(|o| o.trim().eq_ignore_ascii_case(current_os));
    let native_depots: Vec<DepotId> = depot_ids
        .into_iter()
        .filter(|id| {
            let key = id.0.to_string();
            let depot = depots_kv.get(&key);
            match depot {
                None => {
                    log(&format!("  Skipping depot {}: not found in config", id.0));
                    false
                }
                Some(d) => {
                    if d.get("depotfromapp").is_some() {
                        log(&format!("  Skipping depot {}: shared from another app", id.0));
                        return false;
                    }
                    if let Some(config) = d.get("config") {
                        if let Some(oslist) = config.get("oslist").and_then(|o| o.as_str()) {
                            if !os_filter(oslist) {
                                log(&format!("  Skipping depot {}: not for Windows ({})", id.0, oslist));
                                return false;
                            }
                        }
                    }
                    match d.get("manifests").and_then(|m| m.get("public")) {
                        None => {
                            log(&format!("  Skipping depot {}: no public branch", id.0));
                            false
                        }
                        Some(_) => true,
                    }
                }
            }
        })
        .collect();

    if native_depots.is_empty() {
        return Err(format!("No {} depots found for this app", current_os));
    }
    log(&format!("Verifying {} {} depot(s)", native_depots.len(), current_os));

    let cdn_servers = client
        .get_cdn_servers(CellId(0), Some(20))
        .await
        .map_err(|e| e.to_string())?;
    if cdn_servers.is_empty() {
        return Err("No CDN servers available".to_string());
    }

    for depot_id in &native_depots {
        log(&format!("Verifying depot {}...", depot_id.0));

        let manifest_id = find_manifest_for_depot(depots_kv, *depot_id, "public")?;
        log(&format!("  Manifest: {}", manifest_id.0));

        let depot_key = match client
            .get_depot_decryption_key(*depot_id, app_id)
            .await
        {
            Ok(key) => key,
            Err(e) => {
                log(&format!("  get_depot_decryption_key failed: {}", e));
                let (username, refresh_token) = extract_cached_steam_token()
                    .ok_or_else(|| {
                        let diag = extract_steam_token_diag();
                        format!("Failed to extract Steam token: {}\nMake sure Steam is running and you are logged in.", diag)
                    })?;
                log(&format!("Reconnecting with token for user {}", username));
                let (token_logon, token_sid) = build_token_logon(&username, &refresh_token);
                let dc = connect_and_login(ws_server, &token_logon, token_sid).await?;
                dc.get_depot_decryption_key(*depot_id, app_id)
                    .await
                    .map_err(|e| format!("Depot key with token: {}", e))?
            }
        };

        log("  Getting manifest request code...");
        let request_code = match client
            .get_manifest_request_code(app_id, *depot_id, manifest_id, Some("public"), None)
            .await
        {
            Ok(Some(code)) => code,
            Ok(None) => 0,
            Err(e) => {
                log(&format!("  manifest request code unavailable: {}", e));
                0
            }
        };

        log("  Getting CDN auth token...");
        let (cdn_server_index, cdn_auth_token) = {
            let mut idx = 0usize;
            let mut token = None;
            for (i, s) in cdn_servers.iter().enumerate() {
                match client
                    .get_cdn_auth_token(app_id, *depot_id, &s.host)
                    .await
                {
                    Ok(t) => {
                        token = t.token;
                        idx = i;
                        log(&format!("  Got CDN auth token from {}", s.host));
                        break;
                    }
                    Err(e) => {
                        log(&format!("  CDN auth token from {}: {}", s.host, e));
                    }
                }
            }
            (idx, token)
        };
        let cdn_server_for_chunks = &cdn_servers[cdn_server_index];

        log("  Downloading manifest...");
        let cdn = CdnClient::new().map_err(|e| e.to_string())?;
        let manifest_raw = cdn
            .download_manifest(
                cdn_server_for_chunks,
                *depot_id,
                manifest_id,
                request_code,
                cdn_auth_token.as_deref(),
            )
            .await
            .map_err(|e| e.to_string())?;

        let manifest_bytes = decompress_manifest_data(&manifest_raw)?;
        let mut manifest =
            DepotManifest::parse(&manifest_bytes).map_err(|e| e.to_string())?;
        if manifest.filenames_encrypted {
            manifest
                .decrypt_filenames(&depot_key)
                .map_err(|e| e.to_string())?;
        }

        log(&format!(
            "  {} files in manifest",
            manifest.files.len()
        ));

        log("  Downloading files...");

        let cdn_pool = steamroom::cdn::CdnServerPool::new(cdn_servers.clone());
        let fetcher = std::sync::Arc::new(
            steamroom_client::download::CdnChunkFetcher::new(
                CdnClient::new().map_err(|e| e.to_string())?,
                cdn_pool,
                cdn_auth_token,
            ),
        );

        let ac = app_handle.clone();
        let total_files = manifest.files.len();
        let mut ok = 0u64;
        let mut skipped = 0u64;
        let mut bytes_downloaded = 0u64;
        let mut failed: Vec<String> = Vec::new();

        for (fi, file) in manifest.files.iter().enumerate() {
            let _ = ac.emit("verify-file", &file.filename);

            let flags = steamroom::enums::DepotFileFlags(file.flags);
            if flags.is_directory() || file.size == 0 || file.link_target.is_some() {
                skipped += 1;
                let _ = ac.emit("verify-skip", &file.filename);
                continue;
            }

            let file_path = std::path::Path::new(&game_dir).join(&file.filename);

            let skip = file_path.exists()
                && std::fs::metadata(&file_path).map(|m| m.len() == file.size).unwrap_or(false)
                && file.sha_content.as_ref().map_or(true, |expected_sha| {
                    std::fs::read(&file_path).ok().map_or(false, |data| {
                        steamroom::util::checksum::Sha1Hash::compute(&data).0 == *expected_sha
                    })
                });
            if skip {
                skipped += 1;
                bytes_downloaded += file.size;
                let _ = ac.emit("verify-skip", &file.filename);
                continue;
            }

            let file_data = match download_file_v2(*depot_id, &file, &depot_key, &fetcher).await {
                Ok(data) => data,
                Err(e) => {
                    log(&format!("  WARN: {} - skipping", e));
                    failed.push(file.filename.clone());
                    let _ = ac.emit("verify-skip", &file.filename);
                    continue;
                }
            };

            if let Some(parent) = file_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }

            #[cfg(windows)]
            if file_path.exists() {
                if let Ok(meta) = std::fs::metadata(&file_path) {
                    let mut perms = meta.permissions();
                    if perms.readonly() {
                        let _ = perms.set_readonly(false);
                        let _ = std::fs::set_permissions(&file_path, perms);
                    }
                }
            }

            std::fs::write(&file_path, &file_data)
                .map_err(|e| format!("Failed to write {}: {}", file.filename, e))?;

            ok += 1;
            bytes_downloaded += file.size;
            let _ = ac.emit("verify-done", &file.filename);
            let pct = if total_files > 0 {
                ((fi + 1) as f64 / total_files as f64 * 100.0) as u8
            } else {
                0
            };
            let _ = ac.emit("verify-pct", pct);
        }

        log(&format!(
            "  Depot {}: {} OK, {} skipped, {} failed, {} bytes downloaded",
            depot_id.0, ok, skipped, failed.len(), bytes_downloaded
        ));
        if !failed.is_empty() {
            log(&format!(
                "  Failed files: {}",
                failed.join(", ")
            ));
        }
    }

    log("Verification complete!");
    Ok(())
}

fn extract_steam_token_diag() -> String {
    let steam_dir = match find_steam_dir() {
        Some(d) => d,
        None => return "Steam directory not found".to_string(),
    };
    if !steam_dir.join("config/loginusers.vdf").exists() {
        return format!("loginusers.vdf not found in {:?}", steam_dir);
    }
    let username = match detect_steam_username(&steam_dir) {
        Some(u) => u,
        None => {
            let raw = std::fs::read_to_string(steam_dir.join("config/loginusers.vdf")).unwrap_or_default();
            let preview = raw.chars().take(500).collect::<String>();
            return format!("Could not detect Steam username. loginusers.vdf content:\n{}", preview);
        }
    };
    let local_vdf_path = if cfg!(windows) {
        std::env::var("LOCALAPPDATA").map(|s| PathBuf::from(s + "\\Steam\\local.vdf")).ok()
    } else {
        find_local_vdf_path(&steam_dir)
    };
    let local_vdf = match local_vdf_path {
        Some(p) => p,
        None => return format!("local.vdf not found for user {}", username),
    };
    if !local_vdf.exists() {
        return format!("local.vdf not found at {:?}", local_vdf);
    }
    let blob = read_connect_cache_blob(&local_vdf);
    if blob.is_none() {
        return format!("No ConnectCache blob found in local.vdf for user {}", username);
    }
    let hex = blob.as_ref().unwrap();
    if hex.len() < 10 {
        return format!("ConnectCache blob too short ({} chars)", hex.len());
    }
    let encrypted = match hex_decode(hex) {
        Some(e) => e,
        None => return "Failed to hex-decode ConnectCache blob".to_string(),
    };
    #[cfg(windows)]
    {
        let decrypted = match dpapi_decrypt(&encrypted, username.as_bytes()) {
            Some(d) => d,
            None => return format!("DPAPI decrypt failed for user {}", username),
        };
        let token_str = String::from_utf8(decrypted).ok();
        match token_str {
            Some(t) => {
                let trimmed = t.trim();
                let dots = trimmed.matches('.').count();
                if dots != 2 || trimmed.len() <= 20 {
                    return format!("Decrypted token doesn't look like a JWT (dots: {}, len: {})", dots, trimmed.len());
                }
                return format!("Token found successfully (len: {})", trimmed.len());
            }
            None => return "Decrypted bytes are not valid UTF-8".to_string(),
        }
    }
    #[cfg(not(windows))]
    {
        use sha2::Digest;
        if encrypted.len() < 32 {
            return format!("Encrypted blob too short ({} bytes, need >= 32)", encrypted.len());
        }
        let key = sha2::Sha256::digest(username.as_bytes());
        let iv = match steamroom::crypto::symmetric_decrypt_ecb_nopad(&encrypted[..16], &key) {
            Ok(i) => i,
            Err(e) => return format!("AES ECB decrypt failed for IV: {}", e),
        };
        let decrypted = match steamroom::crypto::symmetric_decrypt_cbc(&encrypted[16..], &key, &iv) {
            Ok(d) => d,
            Err(e) => return format!("AES CBC decrypt failed: {}", e),
        };
        let token_str = String::from_utf8(decrypted).ok();
        match token_str {
            Some(t) => {
                let trimmed = t.trim();
                let dots = trimmed.matches('.').count();
                if dots != 2 || trimmed.len() <= 20 {
                    return format!("Decrypted token doesn't look like a JWT (dots: {}, len: {})", dots, trimmed.len());
                }
                return format!("Token found successfully (len: {})", trimmed.len());
            }
            None => return "Decrypted bytes are not valid UTF-8".to_string(),
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    { "Diagnostics not available on this platform".to_string() }
}

fn extract_cached_steam_token() -> Option<(String, String)> {
    let steam_dir = find_steam_dir()?;
    let username = detect_steam_username(&steam_dir)?;
    let token = decrypt_steam_token(&steam_dir, &username)?;
    Some((username, token))
}

fn find_steam_dir() -> Option<PathBuf> {
    if let Ok(steam_dir) = steamlocate::SteamDir::locate() {
        let path = steam_dir.path().to_path_buf();
        if path.join("config").exists() {
            return Some(path);
        }
    }
    #[cfg(windows)]
    {
        let local_app_data = std::env::var("LOCALAPPDATA").ok()?;
        let path = Path::new(&local_app_data).join("Steam");
        if path.join("config").exists() { return Some(path); }
    }
    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").ok()?;
        for p in [Path::new(&home).join(".steam/steam"), Path::new(&home).join(".local/share/Steam")] {
            if p.join("config/loginusers.vdf").exists() { return Some(p); }
        }
    }
    None
}

fn detect_steam_username(steam_dir: &Path) -> Option<String> {
    let content = std::fs::read_to_string(steam_dir.join("config/loginusers.vdf")).ok()?;
    let kv = steamroom::types::key_value::parse_text_kv(&content).ok()?;
    if let steamroom::types::key_value::KvValue::Children(ref users) = kv.value {
        for user_kv in users.values() {
            if user_kv.get("mostrecent").and_then(|v| v.as_str()) == Some("1") {
                return user_kv.get("AccountName").and_then(|v| v.as_str()).map(|s| s.to_string());
            }
        }
        for user_kv in users.values() {
            if let Some(name) = user_kv.get("AccountName").and_then(|v| v.as_str()) {
                return Some(name.to_string());
            }
        }
    }
    None
}

fn decrypt_steam_token(steam_dir: &Path, account_name: &str) -> Option<String> {
    #[cfg(windows)]
    {
        let local_vdf = std::env::var("LOCALAPPDATA").ok()?.to_string() + "\\Steam\\local.vdf";
        let encrypted_hex = read_connect_cache_blob(Path::new(&local_vdf))?;
        let encrypted = hex_decode(&encrypted_hex)?;
        let decrypted = dpapi_decrypt(&encrypted, account_name.as_bytes())?;
        let token = String::from_utf8(decrypted).ok()?;
        let token = token.trim().to_string();
        let is_jwt = token.matches('.').count() == 2 && token.len() > 20;
        if is_jwt { Some(token) } else { None }
    }
    #[cfg(not(windows))]
    {
        use sha2::Digest;
        let local_vdf = find_local_vdf_path(steam_dir)?;
        let encrypted_hex = read_connect_cache_blob(&local_vdf)?;
        let encrypted = hex_decode(&encrypted_hex)?;
        if encrypted.len() < 32 { return None; }
        let key = sha2::Sha256::digest(account_name.as_bytes());
        let iv = steamroom::crypto::symmetric_decrypt_ecb_nopad(&encrypted[..16], &key).ok()?;
        let decrypted = steamroom::crypto::symmetric_decrypt_cbc(&encrypted[16..], &key, &iv).ok()?;
        let token = String::from_utf8(decrypted).ok()?;
        let token = token.trim().to_string();
        let is_jwt = token.matches('.').count() == 2 && token.len() > 20;
        if is_jwt { Some(token) } else { None }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    { None }
}

fn hex_decode(hex_str: &str) -> Option<Vec<u8>> {
    let hex_str = hex_str.trim();
    if hex_str.len() % 2 != 0 {
        return None;
    }
    (0..hex_str.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex_str[i..i + 2], 16).ok())
        .collect()
}

fn read_connect_cache_blob(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let kv = steamroom::types::key_value::parse_text_kv(&content).ok()?;
    let software = kv.get("Software")?;
    let valve = software.get("valve").or_else(|| software.get("Valve"))?;
    let steam = valve.get("Steam")?;
    let cache = steam.get("ConnectCache")?;
    if let steamroom::types::key_value::KvValue::Children(ref entries) = cache.value {
        for entry in entries.values() {
            if let Some(hex) = entry.as_str() {
                return Some(hex.to_string());
            }
        }
    }
    None
}

fn find_local_vdf_path(steam_dir: &Path) -> Option<PathBuf> {
    let p = steam_dir.join("local.vdf");
    if p.exists() { return Some(p); }
    let p = steam_dir.join("config/local.vdf");
    if p.exists() { return Some(p); }
    None
}

#[cfg(windows)]
fn dpapi_decrypt(encrypted: &[u8], entropy: &[u8]) -> Option<Vec<u8>> {
    use std::ffi::c_void;
    use std::ptr;
    #[repr(C)]
    struct DataBlob { cb_data: u32, pb_data: *mut u8 }
    extern "system" {
        fn CryptUnprotectData(
            p_data_in: *const DataBlob, pp_sz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob, pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void, dw_flags: u32, p_data_out: *mut DataBlob,
        ) -> i32;
        fn LocalFree(h_mem: *mut u8) -> *mut u8;
    }
    let input = DataBlob { cb_data: encrypted.len() as u32, pb_data: encrypted.as_ptr() as *mut u8 };
    let ent = DataBlob { cb_data: entropy.len() as u32, pb_data: entropy.as_ptr() as *mut u8 };
    let mut output = DataBlob { cb_data: 0, pb_data: ptr::null_mut() };
    let result = unsafe {
        CryptUnprotectData(&input, ptr::null_mut(), &ent, ptr::null_mut(), ptr::null_mut(), 0x1, &mut output)
    };
    if result == 0 { return None; }
    let decrypted = unsafe { std::slice::from_raw_parts(output.pb_data, output.cb_data as usize) }.to_vec();
    unsafe { LocalFree(output.pb_data); }
    Some(decrypted)
}

fn build_token_logon(
    username: &str,
    token: &str,
) -> (steamroom::generated::CMsgClientLogon, u64) {
    let logon = steamroom::generated::CMsgClientLogon {
        protocol_version: Some(PROTOCOL_VERSION),
        cell_id: Some(0),
        client_os_type: Some(20),
        account_name: Some(username.to_string()),
        access_token: Some(token.to_string()),
        ..Default::default()
    };
    let steam_id = steamroom::types::SteamId::from_parts(1, 1, 1, 0);
    (logon, steam_id.raw())
}

fn build_anon_logon() -> (steamroom::generated::CMsgClientLogon, u64) {
    let logon = steamroom::generated::CMsgClientLogon {
        protocol_version: Some(PROTOCOL_VERSION),
        cell_id: Some(0),
        client_os_type: Some(20),
        ..Default::default()
    };
    let steam_id = steamroom::types::SteamId::from_parts(1, 10, 0, 0);
    (logon, steam_id.raw())
}

fn parse_app_kv(data: &[u8]) -> Result<steamroom::types::key_value::KeyValue, String> {
    if data.first() == Some(&0x00) {
        steamroom::types::key_value::parse_binary_kv(data).map_err(|e| e.to_string())
    } else {
        let text = String::from_utf8_lossy(data);
        steamroom::types::key_value::parse_text_kv(&text).map_err(|e| e.to_string())
    }
}

fn find_manifest_for_depot(
    depots_kv: &steamroom::types::key_value::KeyValue,
    depot_id: DepotId,
    branch: &str,
) -> Result<ManifestId, String> {
    let key = depot_id.0.to_string();
    let depot = depots_kv
        .get(&key)
        .ok_or_else(|| format!("Depot {} not found", depot_id.0))?;

    if let Some(manifests) = depot.get("manifests") {
        if let Some(branch_kv) = manifests.get(branch) {
            if let Some(gid) = branch_kv
                .get("gid")
                .and_then(|g| g.as_str())
            {
                return Ok(ManifestId(
                    gid.parse::<u64>().map_err(|_| "invalid manifest id".to_string())?,
                ));
            }
            if let Some(gid_str) = branch_kv.as_str() {
                return Ok(ManifestId(
                    gid_str
                        .parse::<u64>()
                        .map_err(|_| "invalid manifest id".to_string())?,
                ));
            }
        }
    }

    Err(format!(
        "Manifest not found for depot {} branch {}",
        depot_id.0, branch
    ))
}

fn decompress_manifest_data(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() > 2 && data[0] == 0x50 && data[1] == 0x4B {
        let cursor = std::io::Cursor::new(data);
        let mut archive =
            zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
        let mut file = archive
            .by_index(0)
            .map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut file, &mut buf).map_err(|e| e.to_string())?;
        Ok(buf)
    } else {
        Ok(data.to_vec())
    }
}
