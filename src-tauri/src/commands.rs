use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use uuid::Uuid;

use crate::{
    auth::AuthError,
    bilibili, covers,
    db::DbError,
    diagnostics,
    domain::{
        now_ms, AuthStatus, Bootstrap, CancelResult, CommandError, CommandResult, EngineInfo,
        HistoryEntry, QrLoginPoll, QrLoginStart, RemoveResult, Settings, Task, TaskKind, TaskSpec,
        TaskStatus, VideoProbe,
    },
    engine::{normalize_bilibili_url, EngineError},
    files,
    state::AppState,
};

fn db_error(error: DbError) -> CommandError {
    CommandError::new("database", error.to_string())
}

fn engine_error(error: EngineError) -> CommandError {
    CommandError::new(error.code(), error.message())
}

fn auth_error(error: AuthError) -> CommandError {
    let code = match error {
        AuthError::Network(_) => "network",
        AuthError::Remote(_) => "auth_remote",
        AuthError::InvalidSession => "auth_required",
        AuthError::SecureStorage(_) => "auth_storage",
        AuthError::Qr(_) => "qr_failed",
    };
    CommandError::new(code, error.to_string())
}

fn emit_tasks(app: &AppHandle, task: &Task) {
    let _ = app.emit("tasks://changed", task);
}

fn emit_history(app: &AppHandle) {
    let _ = app.emit("history://changed", ());
}

fn cleanup_output_files(
    output_path: &str,
    kind: TaskKind,
    subtitle_langs: &[String],
    has_danmaku: bool,
    cover_naming: &str,
    download_root: &std::path::Path,
) -> Result<files::FileCleanup, String> {
    match kind {
        TaskKind::Extras => {
            files::remove_extras_folder(output_path, subtitle_langs, has_danmaku, download_root)
        }
        TaskKind::Video => {
            let cleanup = files::remove_download_files(
                output_path,
                subtitle_langs,
                has_danmaku,
                Some(cover_naming),
            )?;
            if let Some(parent) = std::path::Path::new(output_path).parent() {
                if let Err(error) = files::prune_empty_download_dir(parent, download_root) {
                    log::warn!("无法清理空文件夹：{error}");
                }
            }
            Ok(cleanup)
        }
    }
}

#[tauri::command]
pub fn bootstrap(app: AppHandle, state: State<'_, AppState>) -> CommandResult<Bootstrap> {
    Ok(Bootstrap {
        settings: state.settings(),
        tasks: state.db.list_tasks().map_err(db_error)?,
        history: state.db.list_history().map_err(db_error)?,
        engine: state.engine.info(),
        auth: state.auth.status(),
        data_dir: state.data_dir.to_string_lossy().into_owned(),
        autostart: !crate::updates::is_portable() && app.autolaunch().is_enabled().unwrap_or(false),
        portable: crate::updates::is_portable(),
    })
}

#[tauri::command]
pub fn set_autostart(enabled: bool, app: AppHandle) -> CommandResult<bool> {
    if crate::updates::is_portable() {
        return Err(CommandError::new(
            "autostart_portable",
            "便携版不会写入系统启动项。",
        ));
    }
    if enabled {
        app.autolaunch()
            .enable()
            .map_err(|error| CommandError::new("autostart", error.to_string()))?;
    } else {
        app.autolaunch()
            .disable()
            .map_err(|error| CommandError::new("autostart", error.to_string()))?;
    }
    app.autolaunch()
        .is_enabled()
        .map_err(|error| CommandError::new("autostart", error.to_string()))
}

#[tauri::command]
pub fn engine_info(state: State<'_, AppState>) -> EngineInfo {
    state.engine.info()
}

#[tauri::command]
pub async fn probe_video(url: String, state: State<'_, AppState>) -> CommandResult<VideoProbe> {
    let engine = state.engine.clone();
    let data_dir = state.data_dir.clone();
    let cookie_header = state.auth.cookie_header();
    tauri::async_runtime::spawn_blocking(move || {
        let mut probe = engine
            .probe_with_cookies(
                &url,
                cookie_header.as_deref(),
                Some(&data_dir.join("yt-dlp-cache")),
            )
            .map_err(engine_error)?;
        if let Some(bvid) = probe.bvid.clone() {
            match bilibili::fetch_quality_matrix(&bvid, cookie_header.as_deref()) {
                Ok(matrix) => {
                    probe.view_count = matrix.view_count;
                    probe.api_danmaku_count = matrix.danmaku_count;
                    probe.published_at = matrix.published_at;
                    // 只展示同一个 BV 的分 P；合集条目来自同一个 view 响应，不额外发请求。
                    probe.pages = matrix.pages.clone();
                    probe.season = matrix.season.clone();
                    bilibili::apply_quality_matrix(&mut probe, &matrix);
                }
                Err(error) => {
                    log::warn!("清晰度矩阵获取失败（{bvid}），保留 yt-dlp 结果：{error}");
                    probe.warnings.push(if error.is_risk_control() {
                        "B 站触发了访问频率校验，完整清晰度暂不可用；已保留 yt-dlp 解析结果，请稍后重新解析。"
                            .into()
                    } else {
                        "无法获取 B 站完整清晰度权限，锁定档位可能不完整；可登录后重新解析。"
                            .into()
                    });
                }
            }
        }
        if let Some(cover_url) = probe.cover_url.clone() {
            match covers::cache_cover(&data_dir, &cover_url) {
                Ok(path) => probe.cover_path = Some(path.to_string_lossy().into_owned()),
                Err(error) => log::warn!("封面缓存失败：{error}"),
            }
        }
        Ok(probe)
    })
    .await
    .map_err(|error| CommandError::new("engine_failed", format!("解析任务异常：{error}")))?
}

#[tauri::command]
pub async fn auth_status(state: State<'_, AppState>) -> CommandResult<AuthStatus> {
    let auth = state.auth.clone();
    let fallback = auth.status();
    Ok(
        tauri::async_runtime::spawn_blocking(move || auth.validate())
            .await
            .unwrap_or(fallback),
    )
}

#[tauri::command]
pub async fn auth_qr_start(state: State<'_, AppState>) -> CommandResult<QrLoginStart> {
    let auth = state.auth.clone();
    tauri::async_runtime::spawn_blocking(move || auth.qr_start().map_err(auth_error))
        .await
        .map_err(|error| CommandError::new("auth_failed", format!("登录任务异常：{error}")))?
}

#[tauri::command]
pub async fn auth_qr_poll(
    qrcode_key: String,
    state: State<'_, AppState>,
) -> CommandResult<QrLoginPoll> {
    let auth = state.auth.clone();
    tauri::async_runtime::spawn_blocking(move || auth.qr_poll(&qrcode_key).map_err(auth_error))
        .await
        .map_err(|error| CommandError::new("auth_failed", format!("登录轮询异常：{error}")))?
}

#[tauri::command]
pub fn auth_logout(state: State<'_, AppState>) -> CommandResult<AuthStatus> {
    state.auth.logout().map_err(auth_error)
}

/// T06：把 `?p=N` 写进链接（覆盖旧值），这是 B 站官方的分 P 参数。
/// 不改动其他查询参数，也不引入 playlist 遍历。
fn with_page_index(source_url: &str, index: u32) -> Result<String, CommandError> {
    let mut parsed = url::Url::parse(source_url)
        .map_err(|error| CommandError::new("invalid_url", error.to_string()))?;
    let pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(key, _)| key != "p")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    parsed.query_pairs_mut().clear();
    parsed.query_pairs_mut().extend_pairs(pairs);
    parsed
        .query_pairs_mut()
        .append_pair("p", &index.to_string());
    Ok(parsed.to_string())
}

/// T11：`HH:MM:SS` 解析，分钟和秒必须小于 60；返回秒数。
fn section_seconds(value: &str) -> Option<u64> {
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h = parts[0].parse::<u64>().ok()?;
    let m = parts[1].parse::<u64>().ok()?;
    let s = parts[2].parse::<u64>().ok()?;
    (m < 60 && s < 60).then_some(h * 3600 + m * 60 + s)
}

/// 区间必须两端都合法且结束晚于开始，否则任务注定失败。
fn validate_section(start: &str, end: &str) -> Result<(u64, u64), CommandError> {
    match (section_seconds(start), section_seconds(end)) {
        (Some(a), Some(b)) if a < b => Ok((a, b)),
        _ => Err(CommandError::new(
            "invalid_section",
            "片段时间格式应为 HH:MM:SS，且结束时间需晚于开始时间。",
        )),
    }
}

#[tauri::command]
pub fn enqueue_task(
    mut spec: TaskSpec,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Task> {
    let mut source_url = normalize_bilibili_url(&spec.source_url).map_err(engine_error)?;
    // 入队前先做形状校验：这些值会进文件名模板、NFO 与 yt-dlp 的 -f 选择器。
    spec.options
        .validate()
        .map_err(|message| CommandError::new("invalid_options", message))?;
    // T06：分 P 靠标准 `?p=N` 参数选择，仍然保持 --no-playlist，不做列表遍历。
    if let Some(index) = spec.options.page_index {
        source_url = with_page_index(&source_url, index)?;
    }
    // T11：片段区间在入队前校验，避免产生注定失败的任务。
    if let (Some(start), Some(end)) = (
        spec.options.section_start.as_deref(),
        spec.options.section_end.as_deref(),
    ) {
        validate_section(start, end)?;
    }
    // 只读目录 / 超长路径在入队前就拦住，避免排到队列里才失败；
    // 离线移动硬盘（目录暂时不可用）只记警告放行，否则用户换了盘就再也入不了队。
    let download_dir = state.settings().download_dir;
    if let Err(problem) = files::probe_writable(std::path::Path::new(&download_dir)) {
        match problem {
            files::WriteProbeError::PermissionDenied | files::WriteProbeError::PathTooLong => {
                return Err(CommandError::new(problem.code(), problem.message()));
            }
            other => log::warn!("下载目录探针未通过（{other:?}），仍继续入队"),
        }
    }
    let is_extras = spec.kind == TaskKind::Extras;
    if is_extras {
        if spec.danmaku_types.is_empty() && spec.subtitle_langs.is_empty() {
            return Err(CommandError::new(
                "no_extras",
                "请先选择要下载的弹幕类型或字幕语言。",
            ));
        }
    } else {
        if spec.format_id.trim().is_empty() {
            return Err(CommandError::new("invalid_format", "缺少清晰度格式。"));
        }
        if spec.format_id.starts_with("locked-") || spec.format_id.starts_with("unsupported-") {
            return Err(CommandError::new(
                "format_unavailable",
                "该清晰度当前不可下载，请重新解析后再选择。",
            ));
        }
    }

    let now = now_ms();
    let task = Task {
        id: Uuid::new_v4().to_string(),
        kind: spec.kind,
        source_url,
        bvid: spec.bvid,
        title: spec.title.unwrap_or_else(|| "未命名视频".into()),
        uploader: spec.uploader.unwrap_or_else(|| "未知 UP 主".into()),
        cover_url: spec.cover_url,
        cover_path: spec.cover_path,
        duration_seconds: spec.duration_seconds,
        format_id: if is_extras {
            String::new()
        } else {
            spec.format_id
        },
        quality_label: if is_extras {
            if spec.quality_label.trim().is_empty() {
                "附加内容".into()
            } else {
                spec.quality_label
            }
        } else {
            spec.quality_label
        },
        container: if is_extras {
            "extras".into()
        } else {
            spec.container.unwrap_or_else(|| "mp4".into())
        },
        size_bytes: if is_extras { None } else { spec.size_bytes },
        downloaded_bytes: 0,
        speed_bytes_per_sec: 0.0,
        eta_seconds: None,
        status: TaskStatus::Queued,
        error_code: None,
        error_message: None,
        extras_error: None,
        output_path: None,
        temp_dir: None,
        danmaku_types: spec.danmaku_types,
        danmaku_count: spec.danmaku_count,
        subtitle_langs: spec.subtitle_langs,
        engine_version: state.engine.yt_dlp_version(),
        attempt: 0,
        created_at: now,
        queued_at: Some(now),
        started_at: None,
        completed_at: None,
        retry_at: None,
        options: spec.options.clone(),
    };

    if !state
        .db
        .insert_task_if_no_active_duplicate(&task)
        .map_err(db_error)?
    {
        return Err(CommandError::new(
            "duplicate",
            if is_extras {
                "该视频的附加内容已在队列中；请先移除后再试。"
            } else {
                "同一视频与清晰度已在队列中；请先移除或更换清晰度。"
            },
        ));
    }
    emit_tasks(&app, &task);
    state.queue.notify();
    Ok(task)
}

#[tauri::command]
pub fn list_tasks(state: State<'_, AppState>) -> CommandResult<Vec<Task>> {
    state.db.list_tasks().map_err(db_error)
}

#[tauri::command]
pub fn list_history(state: State<'_, AppState>) -> CommandResult<Vec<HistoryEntry>> {
    state.db.list_history().map_err(db_error)
}

#[tauri::command]
pub async fn pause_task(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Task> {
    let task = state
        .db
        .mark_task_paused(&id, None, None)
        .map_err(db_error)?
        .ok_or_else(|| CommandError::new("invalid_state", "当前状态不能暂停。"))?;
    emit_tasks(&app, &task);
    state.queue.stop_task_and_wait(&id).await;
    Ok(task)
}

#[tauri::command]
pub fn resume_task(id: String, app: AppHandle, state: State<'_, AppState>) -> CommandResult<Task> {
    let mut task = state
        .db
        .get_task(&id)
        .map_err(db_error)?
        .ok_or_else(|| CommandError::new("not_found", "任务不存在。"))?;
    if !matches!(
        task.status,
        TaskStatus::Paused | TaskStatus::Failed | TaskStatus::Cancelled
    ) {
        return Err(CommandError::new("invalid_state", "当前状态不能继续。"));
    }
    task.status = TaskStatus::Queued;
    task.error_code = None;
    task.error_message = None;
    task.queued_at = Some(now_ms());
    task.speed_bytes_per_sec = 0.0;
    task.eta_seconds = None;
    task.retry_at = None;
    // 手动继续/重试视为新一轮，自动重试预算重新计算。
    task.attempt = 0;
    state.db.update_task(&task).map_err(db_error)?;
    emit_tasks(&app, &task);
    state.queue.notify();
    Ok(task)
}

#[tauri::command]
pub fn prioritize_task(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Task> {
    let mut task = state
        .db
        .get_task(&id)
        .map_err(db_error)?
        .ok_or_else(|| CommandError::new("not_found", "任务不存在。"))?;
    if task.status != TaskStatus::Queued {
        return Err(CommandError::new(
            "invalid_state",
            "只有等待中的任务可以优先。",
        ));
    }
    let earliest = state
        .db
        .list_tasks()
        .map_err(db_error)?
        .into_iter()
        .filter(|item| item.id != id && item.status == TaskStatus::Queued)
        .filter_map(|item| item.queued_at)
        .min()
        .unwrap_or_else(now_ms);
    task.queued_at = Some(earliest.saturating_sub(1000));
    task.retry_at = None;
    task.error_code = None;
    task.error_message = None;
    state.db.update_task(&task).map_err(db_error)?;
    emit_tasks(&app, &task);
    state.queue.notify();
    Ok(task)
}

#[tauri::command]
pub async fn cancel_task(
    id: String,
    delete_partial: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<CancelResult> {
    let db = state.db.clone();
    let queue = state.queue.clone();
    let data_dir = state.data_dir.clone();
    let mut task = db
        .get_task(&id)
        .map_err(db_error)?
        .ok_or_else(|| CommandError::new("not_found", "任务不存在。"))?;
    if task.status == TaskStatus::Completed {
        return Err(CommandError::new("invalid_state", "已完成任务不能取消。"));
    }

    let previous_status = task.status;
    task.status = TaskStatus::Cancelled;
    task.error_code = Some("cancelled".into());
    task.error_message = Some("任务已取消。".into());
    task.speed_bytes_per_sec = 0.0;
    task.eta_seconds = None;
    task.retry_at = None;
    if !db
        .update_task_if_status(&task, previous_status)
        .map_err(db_error)?
    {
        return Err(CommandError::new(
            "invalid_state",
            "任务状态已变化，无法取消，请刷新后重试。",
        ));
    }
    emit_tasks(&app, &task);
    queue.stop_task_and_wait(&id).await;

    let mut partial_deleted = false;
    let mut delete_error = None;
    if delete_partial.unwrap_or(false) {
        let cleanup_data_dir = data_dir.clone();
        let cleanup_task_id = task.id.clone();
        let stored_temp_dir = task.temp_dir.clone();
        let cleanup = tauri::async_runtime::spawn_blocking(move || {
            files::remove_partial_dir(
                &cleanup_data_dir,
                &cleanup_task_id,
                stored_temp_dir.as_deref(),
            )
        })
        .await;
        match cleanup {
            Ok(Ok(deleted)) => {
                partial_deleted = deleted;
                task.temp_dir = None;
                task.downloaded_bytes = 0;
                task.error_message = Some(if deleted {
                    "任务已取消；临时文件已删除，重新下载会从头开始。".into()
                } else {
                    "任务已取消；没有找到临时文件。".into()
                });
            }
            Ok(Err(message)) => {
                delete_error = Some(message.clone());
                task.error_message = Some(format!("任务已取消；临时文件删除失败：{message}"));
            }
            Err(error) => {
                let message = format!("临时文件清理任务失败：{error}");
                delete_error = Some(message.clone());
                task.error_message = Some(format!("任务已取消；{message}"));
            }
        }
    } else {
        task.error_message = Some("任务已取消；临时文件已保留，可重新下载续传。".into());
    }

    if !db
        .update_task_if_status(&task, TaskStatus::Cancelled)
        .map_err(db_error)?
    {
        log::warn!("取消后的任务状态已变化：{}", task.id);
    }
    emit_tasks(&app, &task);
    Ok(CancelResult {
        task,
        partial_deleted,
        delete_error,
    })
}

#[tauri::command]
pub fn retry_task(id: String, app: AppHandle, state: State<'_, AppState>) -> CommandResult<Task> {
    resume_task(id, app, state)
}

#[tauri::command]
pub async fn delete_task(
    id: String,
    delete_file: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<RemoveResult> {
    let db = state.db.clone();
    let queue = state.queue.clone();
    let data_dir = state.data_dir.clone();
    let task = db.get_task(&id).map_err(db_error)?;
    queue.stop_task(&id);

    let mut file_deleted = false;
    let mut file_error = None;
    if delete_file.unwrap_or(false) {
        if let Some(output_path) = task.as_ref().and_then(|task| task.output_path.clone()) {
            let kind = task.as_ref().map(|task| task.kind).unwrap_or_default();
            let subtitle_langs = task
                .as_ref()
                .map(|task| task.subtitle_langs.clone())
                .unwrap_or_default();
            let has_danmaku = task
                .as_ref()
                .map(|task| !task.danmaku_types.is_empty())
                .unwrap_or(false);
            let settings = state.settings();
            let download_root = settings.download_dir;
            let cover_naming = settings.cover_naming;
            let cleanup = tauri::async_runtime::spawn_blocking(move || {
                cleanup_output_files(
                    &output_path,
                    kind,
                    &subtitle_langs,
                    has_danmaku,
                    &cover_naming,
                    std::path::Path::new(&download_root),
                )
            })
            .await;
            match cleanup {
                Ok(Ok(result)) => {
                    file_deleted = result.main_deleted || result.removed > 0;
                    if !result.errors.is_empty() {
                        file_error = Some(result.errors.join("；"));
                    }
                }
                Ok(Err(message)) => {
                    return Err(CommandError::new("file_delete_failed", message));
                }
                Err(error) => {
                    return Err(CommandError::new(
                        "file_delete_failed",
                        format!("文件清理任务失败：{error}"),
                    ));
                }
            }
        }
    }

    if let Some(task) = task.as_ref() {
        let _ = files::remove_partial_dir(&data_dir, &task.id, task.temp_dir.as_deref());
    }
    db.delete_task(&id).map_err(db_error)?;
    let _ = app.emit("tasks://deleted", &id);
    Ok(RemoveResult {
        file_deleted,
        file_error,
    })
}

#[tauri::command]
pub fn clear_completed(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    state.db.clear_completed().map_err(db_error)?;
    let _ = app.emit("tasks://cleared", ());
    Ok(())
}

#[tauri::command]
pub fn clear_tasks(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    let tasks = state.db.list_tasks().map_err(db_error)?;
    if tasks.iter().any(|task| task.status.is_active()) {
        return Err(CommandError::new(
            "active_tasks",
            "仍有任务在下载，请先暂停或取消。",
        ));
    }
    for task in &tasks {
        let _ = files::remove_partial_dir(&state.data_dir, &task.id, task.temp_dir.as_deref());
    }
    state.db.clear_all_tasks().map_err(db_error)?;
    let _ = app.emit("tasks://cleared", ());
    Ok(())
}

#[tauri::command]
pub async fn delete_history(
    id: String,
    delete_file: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<RemoveResult> {
    let db = state.db.clone();
    let entry = db
        .get_history(&id)
        .map_err(db_error)?
        .ok_or_else(|| CommandError::new("not_found", "历史记录不存在。"))?;

    let mut file_deleted = false;
    let mut file_error = None;
    if delete_file.unwrap_or(false) {
        if let Some(output_path) = entry.output_path.clone() {
            let kind = entry.kind;
            let subtitle_langs = entry.subtitle_langs.clone();
            let has_danmaku = !entry.danmaku_types.is_empty();
            let settings = state.settings();
            let download_root = settings.download_dir;
            let cover_naming = settings.cover_naming;
            let cleanup = tauri::async_runtime::spawn_blocking(move || {
                cleanup_output_files(
                    &output_path,
                    kind,
                    &subtitle_langs,
                    has_danmaku,
                    &cover_naming,
                    std::path::Path::new(&download_root),
                )
            })
            .await;
            match cleanup {
                Ok(Ok(result)) => {
                    file_deleted = result.main_deleted || result.removed > 0;
                    if !result.errors.is_empty() {
                        file_error = Some(result.errors.join("；"));
                    }
                }
                Ok(Err(message)) => {
                    return Err(CommandError::new("file_delete_failed", message));
                }
                Err(error) => {
                    return Err(CommandError::new(
                        "file_delete_failed",
                        format!("文件清理任务失败：{error}"),
                    ));
                }
            }
        }
    }

    db.delete_history(&id).map_err(db_error)?;
    emit_history(&app);
    Ok(RemoveResult {
        file_deleted,
        file_error,
    })
}

#[tauri::command]
pub fn clear_history(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    state.db.clear_history().map_err(db_error)?;
    emit_history(&app);
    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings()
}

#[tauri::command]
pub async fn update_settings(
    mut settings: Settings,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Settings> {
    settings.validate(&state.default_download_dir);
    let previous = state.settings();
    let lowered_concurrency = settings.max_concurrent < previous.max_concurrent;
    state.db.save_settings(&settings).map_err(db_error)?;
    state.set_settings(settings.clone());
    state.queue.notify();
    if lowered_concurrency {
        state.queue.pause_excess(settings.max_concurrent).await;
        let _ = app.emit("tasks://changed", ());
    }
    Ok(settings)
}

#[tauri::command]
pub fn set_minimize_to_tray(enabled: bool, state: State<'_, AppState>) -> CommandResult<Settings> {
    let mut settings = state.settings();
    settings.minimize_to_tray = enabled;
    settings.validate(&state.default_download_dir);
    state.db.save_settings(&settings).map_err(db_error)?;
    state.set_settings(settings.clone());
    Ok(settings)
}

#[tauri::command]
pub fn export_diagnostics(app: AppHandle, state: State<'_, AppState>) -> CommandResult<String> {
    let tasks = state.db.list_tasks().map_err(db_error)?;
    let history_len = state.db.list_history().map_err(db_error)?.len();
    let log_dir = app.path().app_log_dir().ok();
    let version = app.package_info().version.to_string();
    let settings = state.settings();
    // best-effort：目录在离线移动硬盘上时不能让导出失败。
    let writable = files::probe_writable(std::path::Path::new(&settings.download_dir)).is_ok();
    diagnostics::export(
        &state.data_dir,
        &version,
        &state.engine.info(),
        &state.auth.status(),
        &settings,
        &tasks,
        history_len,
        log_dir.as_deref(),
        writable,
    )
    .map(|path| path.to_string_lossy().into_owned())
    .map_err(|message| CommandError::new("diagnostics_failed", message))
}

/// 重新执行引擎发现与完整性校验。用于用户手动替换/修复 sidecar 后免重启恢复。
#[tauri::command]
pub async fn engine_refresh(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<crate::domain::EngineInfo> {
    let resource_dir = app.path().resource_dir().ok();
    let engine = state.engine.clone();
    let info =
        tauri::async_runtime::spawn_blocking(move || engine.refresh(resource_dir.as_deref()))
            .await
            .map_err(|error| {
                CommandError::new("engine_failed", format!("引擎校验异常：{error}"))
            })?;
    log::info!(
        "引擎重新校验：available={} problem={:?}",
        info.available,
        info.problem.as_ref().map(|problem| problem.code.as_str())
    );
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::{validate_section, with_page_index};

    #[test]
    fn writes_page_index_and_keeps_other_query_params() {
        let url = with_page_index(
            "https://www.bilibili.com/video/BV1W7wYetEga/?spm_id_from=333.1387.0.0&vd_source=abc",
            3,
        )
        .unwrap();
        assert!(url.contains("p=3"), "实际：{url}");
        assert!(url.contains("spm_id_from=333.1387.0.0"), "实际：{url}");
        assert!(url.contains("vd_source=abc"), "实际：{url}");
        assert!(!url.contains("playlist"), "不能引入列表遍历：{url}");
    }

    #[test]
    fn replacing_an_existing_page_param_does_not_duplicate_it() {
        let url = with_page_index("https://www.bilibili.com/video/BV1xx411c7mD?p=1", 7).unwrap();
        assert_eq!(url.matches("p=").count(), 1, "实际：{url}");
        assert!(url.contains("p=7"), "实际：{url}");
    }

    #[test]
    fn adds_page_param_without_any_existing_query() {
        let url = with_page_index("https://www.bilibili.com/video/BV1xx411c7mD", 2).unwrap();
        assert!(url.contains("p=2"), "实际：{url}");
    }

    #[test]
    fn accepts_well_formed_section_ranges() {
        assert_eq!(validate_section("00:00:00", "00:01:30").unwrap(), (0, 90));
        assert_eq!(
            validate_section("01:02:03", "02:00:00").unwrap(),
            (3723, 7200)
        );
    }

    #[test]
    fn rejects_bad_or_inverted_section_ranges() {
        // 结束早于开始
        assert!(validate_section("00:10:00", "00:05:00").is_err());
        // 首尾相同，等于零长度
        assert!(validate_section("00:05:00", "00:05:00").is_err());
        // 少一段
        assert!(validate_section("10:00", "20:00").is_err());
        // 分钟/秒越界
        assert!(validate_section("00:60:00", "01:00:00").is_err());
        assert!(validate_section("00:00:60", "00:02:00").is_err());
        // 非数字
        assert!(validate_section("aa:bb:cc", "00:02:00").is_err());
        // 负数
        assert!(validate_section("-1:00:00", "00:02:00").is_err());
    }
}
