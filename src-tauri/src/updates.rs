use std::{env, fs, path::PathBuf, time::Duration};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::domain::{CommandError, CommandResult};

const ENDPOINT_ENV: &str = "BILIPOCKET_UPDATE_ENDPOINT";
const SOURCE_FILE: &str = "update-source.txt";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub configured: bool,
    pub current_version: String,
    pub portable: bool,
}

pub(crate) fn is_portable() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.parent()
                .map(|parent| parent.join("BiliPocket.portable").is_file())
        })
        .unwrap_or(false)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
}

fn read_source(path: &PathBuf) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    content
        .lines()
        .map(|line| line.trim().trim_start_matches('\u{feff}'))
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
}

pub fn endpoint(app: &AppHandle) -> Option<String> {
    if let Ok(value) = env::var(ENDPOINT_ENV) {
        let value = value.trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    let mut candidates = Vec::new();
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(SOURCE_FILE));
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(SOURCE_FILE));
        candidates.push(resource_dir.join("_up_").join(SOURCE_FILE));
    }
    if cfg!(debug_assertions) {
        if let Ok(current) = env::current_dir() {
            candidates.push(current.join("src-tauri").join(SOURCE_FILE));
            candidates.push(current.join(SOURCE_FILE));
        }
    }
    candidates.into_iter().find_map(|path| read_source(&path))
}

fn configured_updater(app: &AppHandle) -> CommandResult<tauri_plugin_updater::Updater> {
    let endpoint = endpoint(app).ok_or_else(|| {
        CommandError::new(
            "update_not_configured",
            "当前构建未配置签名更新源；发布前请在 update-source.txt 或 BILIPOCKET_UPDATE_ENDPOINT 中配置 HTTPS 地址。",
        )
    })?;
    let url = url::Url::parse(&endpoint)
        .map_err(|error| CommandError::new("update_config", format!("更新源地址无效：{error}")))?;
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|error| CommandError::new("update_config", error.to_string()))?
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|error| CommandError::new("update_config", error.to_string()))
}

#[tauri::command]
pub fn update_status(app: AppHandle) -> UpdateStatus {
    UpdateStatus {
        configured: endpoint(&app).is_some(),
        current_version: app.package_info().version.to_string(),
        portable: is_portable(),
    }
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> CommandResult<UpdateCheckResult> {
    if is_portable() {
        return Err(CommandError::new(
            "update_portable",
            "便携版不会自动覆盖文件；请下载新版本便携包并手动替换。",
        ));
    }
    let updater = configured_updater(&app)?;
    let current_version = app.package_info().version.to_string();
    let update = updater
        .check()
        .await
        .map_err(|error| CommandError::new("update_check_failed", error.to_string()))?;
    Ok(match update {
        Some(update) => UpdateCheckResult {
            available: true,
            current_version,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
            published_at: update.date.map(|date| date.to_string()),
        },
        None => UpdateCheckResult {
            available: false,
            current_version,
            version: None,
            notes: None,
            published_at: None,
        },
    })
}

#[tauri::command]
pub async fn update_install(app: AppHandle) -> CommandResult<()> {
    if is_portable() {
        return Err(CommandError::new(
            "update_portable",
            "便携版不会自动覆盖文件；请下载新版本便携包并手动替换。",
        ));
    }
    let updater = configured_updater(&app)?;
    let update = updater
        .check()
        .await
        .map_err(|error| CommandError::new("update_check_failed", error.to_string()))?
        .ok_or_else(|| CommandError::new("update_unavailable", "当前已是最新版本。"))?;
    let progress_app = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                let _ = progress_app.emit(
                    "update://progress",
                    serde_json::json!({ "downloaded": chunk, "total": total }),
                );
            },
            || {},
        )
        .await
        .map_err(|error| CommandError::new("update_install_failed", error.to_string()))
}
