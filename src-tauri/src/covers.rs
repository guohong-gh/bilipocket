use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

use thiserror::Error;
use url::Url;
use uuid::Uuid;

const MAX_COVER_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CACHE_FILES: usize = 300;
const MAX_CACHE_AGE: Duration = Duration::from_secs(90 * 24 * 60 * 60);
const COVER_HOSTS: [&str; 2] = ["hdslb.com", "biliimg.com"];

#[derive(Debug, Error)]
pub enum CoverError {
    #[error("封面地址不受支持")]
    InvalidUrl,
    #[error("封面下载失败：{0}")]
    Network(String),
    #[error("封面格式不受支持")]
    UnsupportedType,
    #[error("封面文件过大")]
    TooLarge,
    #[error("封面写入失败：{0}")]
    Io(#[from] std::io::Error),
}

pub fn is_allowed_cover_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    COVER_HOSTS
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

fn stable_key(url: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in url.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn extension_for(content_type: &str, url: &Url) -> Option<&'static str> {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match mime.as_str() {
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => {
            let path = url.path().to_ascii_lowercase();
            if path.ends_with(".jpg") || path.ends_with(".jpeg") {
                Some("jpg")
            } else if path.ends_with(".png") {
                Some("png")
            } else if path.ends_with(".webp") {
                Some("webp")
            } else {
                None
            }
        }
    }
}

fn existing(base_dir: &Path, key: &str) -> Option<PathBuf> {
    ["jpg", "png", "webp", "gif"].iter().find_map(|ext| {
        let candidate = base_dir.join(format!("{key}.{ext}"));
        candidate.is_file().then_some(candidate)
    })
}

pub fn cache_cover(data_dir: &Path, raw_url: &str) -> Result<PathBuf, CoverError> {
    let mut url = Url::parse(raw_url).map_err(|_| CoverError::InvalidUrl)?;
    if url.scheme() == "http"
        && is_allowed_cover_url(&format!("https://{}", url.host_str().unwrap_or_default()))
    {
        let _ = url.set_scheme("https");
    }
    let normalized = url.to_string();
    if !is_allowed_cover_url(&normalized) {
        return Err(CoverError::InvalidUrl);
    }
    let directory = data_dir.join("covers");
    fs::create_dir_all(&directory)?;
    let key = stable_key(&normalized);
    if let Some(path) = existing(&directory, &key) {
        return Ok(path);
    }

    let client = reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) BiliPocket/0.9")
        .referer(true)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| CoverError::Network(error.to_string()))?;
    let response = client
        .get(url.clone())
        .header(reqwest::header::REFERER, "https://www.bilibili.com/")
        .send()
        .map_err(|error| CoverError::Network(error.to_string()))?;
    if !response.status().is_success() {
        return Err(CoverError::Network(format!(
            "Bilibili 返回 HTTP {}",
            response.status().as_u16()
        )));
    }
    if response.content_length().unwrap_or(0) > MAX_COVER_BYTES {
        return Err(CoverError::TooLarge);
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let extension = extension_for(&content_type, &url).ok_or(CoverError::UnsupportedType)?;

    let mut bytes = Vec::new();
    response
        .take(MAX_COVER_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| CoverError::Network(error.to_string()))?;
    if bytes.len() as u64 > MAX_COVER_BYTES {
        return Err(CoverError::TooLarge);
    }
    if bytes.is_empty() {
        return Err(CoverError::UnsupportedType);
    }

    let target = directory.join(format!("{key}.{extension}"));
    let temporary = directory.join(format!("{key}.{extension}.{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, &bytes)?;
    if let Err(error) = fs::rename(&temporary, &target) {
        let _ = fs::remove_file(&temporary);
        if target.is_file() {
            return Ok(target);
        }
        return Err(CoverError::Io(error));
    }
    if let Err(error) = prune_cache_impl(&directory, MAX_CACHE_FILES, MAX_CACHE_AGE) {
        log::warn!("清理封面缓存失败：{error}");
    }
    Ok(target)
}

fn prune_cache_impl(directory: &Path, max_files: usize, max_age: Duration) -> std::io::Result<()> {
    let now = std::time::SystemTime::now();
    let mut files = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let path = entry.path();
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !matches!(extension.as_str(), "jpg" | "png" | "webp" | "gif") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        files.push((modified, path));
    }
    files.sort_by_key(|(modified, _)| *modified);
    let removable = files
        .iter()
        .filter(|(modified, _)| {
            now.duration_since(*modified)
                .map(|age| age > max_age)
                .unwrap_or(false)
        })
        .count();
    let overflow = files.len().saturating_sub(max_files);
    let remove_count = removable.max(overflow);
    for (_, path) in files.into_iter().take(remove_count) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    #[test]
    fn prunes_cache_overflow_and_old_files() {
        let directory =
            std::env::temp_dir().join(format!("bilipocket-cover-cache-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        for index in 0..4 {
            let path = directory.join(format!("{index}.jpg"));
            fs::write(&path, b"x").unwrap();
            let file = fs::File::options().write(true).open(&path).unwrap();
            file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(index))
                .unwrap();
        }
        let old = directory.join("old.png");
        fs::write(&old, b"x").unwrap();
        fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(SystemTime::UNIX_EPOCH)
            .unwrap();

        prune_cache_impl(&directory, 2, Duration::from_secs(100 * 365 * 24 * 60 * 60)).unwrap();
        let remaining = fs::read_dir(&directory).unwrap().count();
        assert_eq!(remaining, 2);
        assert!(!old.exists());
        let names = fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(names.contains(&"2.jpg".to_string()));
        assert!(names.contains(&"3.jpg".to_string()));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn accepts_only_bilibili_https_covers() {
        assert!(is_allowed_cover_url(
            "https://i0.hdslb.com/bfs/archive/example.jpg"
        ));
        assert!(is_allowed_cover_url(
            "https://archive.biliimg.com/bfs/archive/example.png"
        ));
        assert!(!is_allowed_cover_url("http://i0.hdslb.com/example.jpg"));
        assert!(!is_allowed_cover_url(
            "https://i0.hdslb.com.evil.test/a.jpg"
        ));
        assert!(!is_allowed_cover_url("https://example.com/a.jpg"));
        assert!(!is_allowed_cover_url("file:///C:/secret.jpg"));
    }

    #[test]
    fn cache_key_is_stable_and_distinct() {
        let first = stable_key("https://i0.hdslb.com/a.jpg");
        assert_eq!(first, stable_key("https://i0.hdslb.com/a.jpg"));
        assert_ne!(first, stable_key("https://i0.hdslb.com/b.jpg"));
        assert_eq!(first.len(), 16);
    }

    #[test]
    fn maps_supported_image_types() {
        let url = Url::parse("https://i0.hdslb.com/cover").unwrap();
        assert_eq!(extension_for("image/webp", &url), Some("webp"));
        assert_eq!(
            extension_for("image/jpeg; charset=utf-8", &url),
            Some("jpg")
        );
        assert_eq!(extension_for("image/svg+xml", &url), None);
        let jpg_url = Url::parse("https://i0.hdslb.com/cover.JPG").unwrap();
        assert_eq!(
            extension_for("application/octet-stream", &jpg_url),
            Some("jpg")
        );
    }
}
