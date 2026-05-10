use steamworks::AppId;

fn main() {
    let work_dir = std::env::args().nth(1);
    if let Some(ref dir) = work_dir {
        let _ = std::env::set_current_dir(dir);
    }

    let client = match steamworks::Client::init_app(AppId(2231450)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[cheezy-steam-helper] init failed: {}", e);
            std::process::exit(1);
        }
    };

    loop {
        client.run_callbacks();
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}
