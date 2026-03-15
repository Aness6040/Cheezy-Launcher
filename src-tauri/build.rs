use std::fs;
use std::path::Path;

fn main() {
    let src = Path::new("src/deps");
    let dest = Path::new("target/debug/deps");

    if !dest.exists() {
        fs::create_dir_all(dest).unwrap();
    }

    for entry in fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        let filename = path.file_name().unwrap();

        let dest_path = dest.join(filename);
        fs::copy(&path, dest_path).unwrap();
    }

    println!("cargo:rerun-if-changed=deps/");
    tauri_build::build()
}
