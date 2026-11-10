//! Library and settings are plain JSON files in %APPDATA%\com.superprompt.creator.

use std::path::{Path, PathBuf};

fn file_for(dir: &Path, name: &str) -> Result<PathBuf, String> {
    match name {
        "library" | "settings" => Ok(dir.join(format!("{name}.json"))),
        _ => Err(format!("Unknown store '{name}'.")),
    }
}

pub fn read(dir: &Path, name: &str) -> Result<Option<String>, String> {
    let p = file_for(dir, name)?;
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // A crash between writes leaves the previous copy in .bak.
            Ok(std::fs::read_to_string(p.with_extension("json.bak")).ok())
        }
        Err(e) => Err(format!("Couldn't read {name}: {e}")),
    }
}

pub fn write(dir: &Path, name: &str, data: &str) -> Result<(), String> {
    if data.len() > 64 * 1024 * 1024 {
        return Err("That's too much data to save.".into());
    }
    serde_json::from_str::<serde_json::Value>(data).map_err(|e| format!("Refusing to save broken data: {e}"))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create the data folder: {e}"))?;
    let p = file_for(dir, name)?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, data).map_err(|e| format!("Couldn't save {name}: {e}"))?;
    if p.exists() {
        let _ = std::fs::copy(&p, p.with_extension("json.bak"));
    }
    std::fs::rename(&tmp, &p).map_err(|e| format!("Couldn't save {name}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_backup() {
        let dir = std::env::temp_dir().join(format!("spc-store-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(read(&dir, "library").unwrap(), None);
        write(&dir, "library", "[1]").unwrap();
        write(&dir, "library", "[1,2]").unwrap();
        assert_eq!(read(&dir, "library").unwrap().as_deref(), Some("[1,2]"));
        std::fs::remove_file(dir.join("library.json")).unwrap();
        assert_eq!(read(&dir, "library").unwrap().as_deref(), Some("[1]"));
        assert!(write(&dir, "library", "{broken").is_err());
        assert!(write(&dir, "../evil", "[]").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
