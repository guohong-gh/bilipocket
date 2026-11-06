use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::{watch, Notify},
};
use uuid::Uuid;

use crate::{
    auth::AuthManager,
    db::Db,
    domain::{
        now_ms, HistoryEntry, Settings, Task, TaskKind, TaskStatus, VideoProbe,
        DEFAULT_RETRY_BASE_SECONDS, DEFAULT_RETRY_MAX, MAX_RETRY_MAX,
    },
    engine::{Engine, EngineError},
    files,
    process_job::ProcessJob,
    util::LockExt,
};

struct RunningTask {
    token: u64,
    cancel: watch::Sender<bool>,
    handle: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Default)]
struct ExtrasWriteResult {
    written: Vec<PathBuf>,
    errors: Vec<String>,
    danmaku_count: u64,
    failure_code: Option<String>,
}

const PROBE_TIMEOUT: Duration = Duration::from_secs(60);

/// 任务级重试策略。`Default` 必须与历史常量一致，否则既有单元测试与用户预期都会变。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RetryPolicy {
    max: u32,
    base_seconds: i64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max: DEFAULT_RETRY_MAX,
            base_seconds: DEFAULT_RETRY_BASE_SECONDS as i64,
        }
    }
}

impl RetryPolicy {
    fn from_settings(settings: &Settings) -> Self {
        Self {
            max: settings.retry_max.min(MAX_RETRY_MAX),
            base_seconds: settings.retry_base_seconds.clamp(3, 300) as i64,
        }
    }
}

fn is_retryable_error(code: &str) -> bool {
    matches!(
        code,
        "timeout"
            | "rate_limited"
            | "risk_control"
            | "download_failed"
            | "engine_failed"
            | "network"
            | "sidecar_failed"
    )
}

fn retry_delay_seconds(code: &str, attempt: u32, base_seconds: i64) -> i64 {
    if code == "risk_control" {
        // 风控不是"越快越好"：2× / 6× / 12× 基础间隔，base=15 时即 30 / 90 / 180。
        let factor = match attempt.saturating_sub(1) {
            0 => 2,
            1 => 6,
            _ => 12,
        };
        return base_seconds * factor;
    }
    let exponent = attempt.saturating_sub(1).min(3);
    base_seconds * 2_i64.pow(exponent)
}

#[derive(Debug, PartialEq, Eq)]
enum FailurePlan {
    Retry { attempt: u32, delay_seconds: i64 },
    Terminal { status: TaskStatus },
}

fn plan_failure(attempt: u32, code: &str, policy: &RetryPolicy) -> FailurePlan {
    if is_retryable_error(code) && attempt < policy.max {
        let next = attempt + 1;
        return FailurePlan::Retry {
            attempt: next,
            delay_seconds: retry_delay_seconds(code, next, policy.base_seconds),
        };
    }
    // 权限与风控都不是"任务本身错了"，退避耗尽后转暂停让用户稍后继续，而不是判死。
    let pausable = matches!(code, "auth_required" | "vip_required" | "risk_control");
    FailurePlan::Terminal {
        status: if pausable {
            TaskStatus::Paused
        } else {
            TaskStatus::Failed
        },
    }
}

struct JobGuard<'a> {
    queue: &'a Queue,
    task_id: String,
}

impl Drop for JobGuard<'_> {
    fn drop(&mut self) {
        if let Some(job) = self
            .queue
            .jobs
            .lock_or_recover("jobs")
            .remove(&self.task_id)
        {
            job.terminate();
        }
    }
}

pub struct Queue {
    db: Arc<Db>,
    engine: Arc<Engine>,
    settings: Arc<Mutex<Settings>>,
    auth: Arc<AuthManager>,
    data_dir: PathBuf,
    app: AppHandle,
    running: Mutex<HashMap<String, RunningTask>>,
    jobs: Mutex<HashMap<String, Arc<ProcessJob>>>,
    next_token: AtomicU64,
    notify: Notify,
}

#[derive(Debug)]
struct RunError {
    code: String,
    message: String,
}

fn cancelled_run_error() -> RunError {
    RunError {
        code: "cancelled".into(),
        message: "任务已取消。".into(),
    }
}

impl Queue {
    pub fn new(
        db: Arc<Db>,
        engine: Arc<Engine>,
        settings: Arc<Mutex<Settings>>,
        auth: Arc<AuthManager>,
        data_dir: PathBuf,
        app: AppHandle,
    ) -> Self {
        Self {
            db,
            engine,
            settings,
            auth,
            data_dir,
            app,
            running: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
            next_token: AtomicU64::new(1),
            notify: Notify::new(),
        }
    }

    pub fn start(self: &Arc<Self>) {
        let queue = self.clone();
        tauri::async_runtime::spawn(async move {
            queue.dispatch_loop().await;
        });
    }

    pub fn notify(&self) {
        self.notify.notify_one();
    }

    pub fn stop_task(&self, id: &str) {
        if let Some(job) = self.jobs.lock_or_recover("jobs").remove(id) {
            job.terminate();
        }
        if let Some(mut running) = self
            .running
            .lock_or_recover("running")
            .remove(id)
        {
            let _ = running.cancel.send(true);
            if let Some(handle) = running.handle.take() {
                handle.abort();
            }
        }
        self.notify();
    }

    pub async fn stop_task_and_wait(&self, id: &str) {
        if let Some(job) = self.jobs.lock_or_recover("jobs").remove(id) {
            job.terminate();
        }
        let running = self
            .running
            .lock_or_recover("running")
            .remove(id);
        if let Some(mut running) = running {
            let _ = running.cancel.send(true);
            if let Some(mut handle) = running.handle.take() {
                handle.abort();
                let _ = tokio::time::timeout(Duration::from_secs(3), &mut handle).await;
            }
        }
        self.notify();
    }

    pub fn stop_all(&self) {
        for (_, job) in self.jobs.lock_or_recover("jobs").drain() {
            job.terminate();
        }
        let mut running = self.running.lock_or_recover("running");
        for (_, mut task) in running.drain() {
            let _ = task.cancel.send(true);
            if let Some(handle) = task.handle.take() {
                handle.abort();
            }
        }
        self.notify();
    }

    pub async fn pause_excess(&self, limit: u32) {
        let Ok(tasks) = self.db.list_tasks() else {
            return;
        };
        let mut active = tasks
            .into_iter()
            .filter(|task| task.status.is_active())
            .collect::<Vec<_>>();
        active.sort_by_key(|task| task.started_at.unwrap_or(task.created_at));
        for task in active.into_iter().skip(limit as usize) {
            let paused = match self.db.mark_task_paused(
                &task.id,
                Some("concurrency"),
                Some("已按新的并发上限暂停，可稍后继续。"),
            ) {
                Ok(Some(task)) => task,
                Ok(None) => continue,
                Err(error) => {
                    log::warn!("无法暂停超出并发上限的任务：{error}");
                    continue;
                }
            };
            self.emit_task(&paused);
            self.stop_task_and_wait(&paused.id).await;
        }
    }

    async fn dispatch_loop(self: Arc<Self>) {
        loop {
            loop {
                let max_concurrent = self
                    .settings
                    .lock_or_recover("settings")
                    .max_concurrent
                    .max(1) as usize;
                if self
                    .running
                    .lock_or_recover("running")
                    .len()
                    >= max_concurrent
                {
                    break;
                }

                let db = self.db.clone();
                let tasks = match tokio::task::spawn_blocking(move || db.list_tasks()).await {
                    Ok(Ok(tasks)) => tasks,
                    Ok(Err(error)) => {
                        log::warn!("无法读取任务队列：{error}");
                        break;
                    }
                    Err(error) => {
                        log::warn!("队列任务异常：{error}");
                        break;
                    }
                };
                let now = now_ms();
                let next = tasks
                    .into_iter()
                    .filter(|task| {
                        task.status == TaskStatus::Queued
                            && task
                                .retry_at
                                .map(|retry_at| retry_at <= now)
                                .unwrap_or(true)
                    })
                    .min_by_key(|task| {
                        (task.queued_at.unwrap_or(task.created_at), task.created_at)
                    });

                let Some(task) = next else {
                    break;
                };
                if !self.start_task(task) {
                    break;
                }
            }

            tokio::select! {
                _ = self.notify.notified() => {}
                _ = tokio::time::sleep(Duration::from_secs(2)) => {}
            }
        }
    }

    fn start_task(self: &Arc<Self>, mut task: Task) -> bool {
        if self
            .running
            .lock_or_recover("running")
            .contains_key(&task.id)
        {
            return false;
        }

        let token = self.next_token.fetch_add(1, Ordering::Relaxed);
        let (cancel, cancel_rx) = watch::channel(false);
        self.running
            .lock_or_recover("running")
            .insert(
                task.id.clone(),
                RunningTask {
                    token,
                    cancel,
                    handle: None,
                },
            );

        task.status = TaskStatus::Probing;
        task.error_code = None;
        task.error_message = None;
        task.extras_error = None;
        task.started_at = Some(now_ms());
        task.speed_bytes_per_sec = 0.0;
        task.eta_seconds = None;
        task.retry_at = None;
        match self.db.update_task_if_status(&task, TaskStatus::Queued) {
            Ok(true) => {}
            Ok(false) => {
                self.release_claim(&task.id, token);
                return false;
            }
            Err(error) => {
                log::warn!("无法标记任务开始：{error}");
                self.release_claim(&task.id, token);
                return false;
            }
        }
        self.emit_task(&task);

        if *cancel_rx.borrow() {
            self.release_claim(&task.id, token);
            return false;
        }

        let queue = self.clone();
        let task_id = task.id.clone();
        let finish_id = task_id.clone();
        let handle = tokio::spawn(async move {
            queue.clone().run_task(task, cancel_rx).await;
            queue.finish(&finish_id, token);
        });
        let mut pending = Some(handle);
        {
            let mut running = self.running.lock_or_recover("running");
            if let Some(entry) = running.get_mut(&task_id) {
                if entry.token == token {
                    entry.handle = pending.take();
                }
            }
        }
        if let Some(handle) = pending {
            handle.abort();
            return false;
        }
        self.notify();
        true
    }

    fn release_claim(&self, id: &str, token: u64) {
        let mut running = self.running.lock_or_recover("running");
        if running.get(id).map(|entry| entry.token) == Some(token) {
            running.remove(id);
        }
    }

    fn finish(&self, id: &str, token: u64) {
        let mut running = self.running.lock_or_recover("running");
        if running.get(id).map(|task| task.token) == Some(token) {
            running.remove(id);
        }
        drop(running);
        self.notify();
    }

    fn retry_policy(&self) -> RetryPolicy {
        let settings = self.settings.lock_or_recover("settings");
        RetryPolicy::from_settings(&settings)
    }

    fn fragment_retries(&self) -> u32 {
        self.settings
            .lock_or_recover("settings")
            .fragment_retries
    }

    fn subtitle_format(&self) -> String {
        self.settings
            .lock_or_recover("settings")
            .subtitle_format
            .clone()
    }

    /// T13：并发任务多时拉长进度事件间隔，避免 50 个任务把事件与 DB 写放大 10 倍。
    /// 单任务仍是 500ms（2 事件/秒），远低于验收上限 10 事件/秒。
    fn progress_interval(&self) -> Duration {
        // 中毒时若按 0 处理会让调度器误判「没有任务在跑」而超发，这里取真实数量。
        let active = self.running.lock_or_recover("running").len();
        progress_interval_for(active)
    }

    async fn run_task(self: Arc<Self>, mut task: Task, mut cancel: watch::Receiver<bool>) {
        if *cancel.borrow() {
            return;
        }
        if let Err(error) = self.execute_task(&mut task, &mut cancel).await {
            if !self.task_is_active(&task.id) {
                return;
            }
            let policy = self.retry_policy();
            match plan_failure(task.attempt, &error.code, &policy) {
                FailurePlan::Retry {
                    attempt,
                    delay_seconds,
                } => {
                    task.attempt = attempt;
                    task.status = TaskStatus::Queued;
                    task.retry_at = Some(now_ms() + delay_seconds * 1000);
                    task.error_code = Some(error.code);
                    task.error_message = Some(format!(
                        "将在 {delay_seconds} 秒后自动重试（第 {attempt}/{} 次）：{}",
                        policy.max, error.message
                    ));
                    task.speed_bytes_per_sec = 0.0;
                    task.eta_seconds = None;
                    task.queued_at = Some(now_ms());
                    if !self.write_if_active(&task) {
                        log::warn!("任务状态已变化，跳过自动重试：{}", task.id);
                        return;
                    }
                    self.emit_task(&task);
                    self.notify();
                }
                FailurePlan::Terminal { status } => {
                    task.status = status;
                    task.error_code = Some(error.code);
                    task.error_message = Some(error.message);
                    task.speed_bytes_per_sec = 0.0;
                    task.eta_seconds = None;
                    task.retry_at = None;
                    if !self.write_if_active(&task) {
                        log::warn!("任务状态已变化，保留用户操作：{}", task.id);
                        return;
                    }
                    self.emit_task(&task);
                }
            }
        }
    }

    fn write_if_active(&self, task: &Task) -> bool {
        let active = [
            TaskStatus::Probing,
            TaskStatus::Downloading,
            TaskStatus::Muxing,
            TaskStatus::Extras,
        ];
        self.db
            .update_task_if_status_in(task, &active)
            .unwrap_or(false)
    }

    async fn probe_video(
        &self,
        task: &Task,
        cookie_header: Option<&str>,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<VideoProbe, RunError> {
        let command = self
            .engine
            .probe_command(
                &task.source_url,
                cookie_header,
                Some(&self.data_dir.join("yt-dlp-cache")),
            )
            .map_err(engine_run_error)?;
        let mut command = tokio::process::Command::from(command);
        // tokio 的 From 实现会把 stdio 重置为 null，这里必须重新接管管道。
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .kill_on_drop(true);
        let child = command.spawn().map_err(|error| RunError {
            code: "engine_failed".into(),
            message: format!("无法启动 yt-dlp：{error}"),
        })?;
        if let Some(job) = crate::process_job::attach(&child) {
            self.jobs
                .lock_or_recover("jobs")
                .insert(task.id.clone(), job);
        }
        let _job_guard = JobGuard {
            queue: self,
            task_id: task.id.clone(),
        };
        let output = tokio::select! {
            result = child.wait_with_output() => result.map_err(|error| RunError {
                code: "engine_failed".into(),
                message: format!("等待 yt-dlp 退出失败：{error}"),
            })?,
            _ = cancel.changed() => return Err(cancelled_run_error()),
            _ = tokio::time::sleep(PROBE_TIMEOUT) => {
                return Err(RunError {
                    code: "timeout".into(),
                    message: format!(
                        "解析超时（{} 秒），请检查网络后重试。",
                        PROBE_TIMEOUT.as_secs()
                    ),
                });
            }
        };
        self.engine
            .finish_probe(output, &task.source_url, false)
            .map_err(engine_run_error)
    }

    async fn execute_task(
        &self,
        task: &mut Task,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<(), RunError> {
        let cookie_header = self.auth.cookie_header();
        let probe = self
            .probe_video(task, cookie_header.as_deref(), cancel)
            .await?;

        let quality = if task.kind == TaskKind::Video {
            Some(
                probe
                    .qualities
                    .iter()
                    .find(|quality| quality.format_id == task.format_id)
                    .cloned()
                    .ok_or_else(|| RunError {
                        code: "format_unavailable".into(),
                        message: "所选清晰度已不可用，请重新解析后再下载。".into(),
                    })?,
            )
        } else {
            None
        };

        task.title = probe.title.clone();
        task.uploader = probe.uploader.clone();
        task.bvid = probe.bvid.clone();
        task.cover_url = probe.cover_url.clone();
        if let Some(path) = probe.cover_path.clone() {
            task.cover_path = Some(path);
        }
        task.duration_seconds = probe.duration_seconds;
        if let Some(quality) = &quality {
            task.quality_label = if task.quality_label.is_empty() || task.quality_label == "—" {
                quality.label.clone()
            } else {
                task.quality_label.clone()
            };
            task.container = quality.container.clone();
            task.size_bytes = quality.size_bytes;
        }
        task.engine_version = Some(probe.engine_version);
        let danmaku_url = probe.danmaku.url.clone();
        let selected_subtitles = task.subtitle_langs.clone();
        let selected_danmaku = task.danmaku_types.clone();

        if task
            .cover_path
            .as_deref()
            .map(|path| !Path::new(path).is_file())
            .unwrap_or(true)
        {
            if let Some(cover_url) = task.cover_url.clone() {
                let data_dir = self.data_dir.clone();
                match tokio::task::spawn_blocking(move || {
                    crate::covers::cache_cover(&data_dir, &cover_url)
                })
                .await
                {
                    Ok(Ok(path)) => {
                        task.cover_path = Some(path.to_string_lossy().into_owned());
                    }
                    Ok(Err(error)) => log::warn!("封面缓存失败：{error}"),
                    Err(error) => log::warn!("封面缓存任务失败：{error}"),
                }
            }
        }

        let settings = self
            .settings
            .lock_or_recover("settings")
            .clone();
        std::fs::create_dir_all(&settings.download_dir).map_err(|error| RunError {
            code: "permission_denied".into(),
            message: format!("无法创建下载目录：{error}"),
        })?;

        let temp_dir = self.data_dir.join("parts").join(&task.id);
        std::fs::create_dir_all(&temp_dir).map_err(|error| RunError {
            code: "disk_error".into(),
            message: format!("无法创建临时目录：{error}"),
        })?;
        task.temp_dir = Some(temp_dir.to_string_lossy().into_owned());

        if !self
            .db
            .update_task_metadata_if_status(task, &[TaskStatus::Probing])
            .map_err(db_run_error)?
        {
            return Err(cancelled_run_error());
        }

        if task.kind == TaskKind::Extras {
            return self
                .execute_extras_task(
                    task,
                    &settings,
                    &temp_dir,
                    danmaku_url,
                    cookie_header.as_deref(),
                )
                .await;
        }

        check_disk_space(
            Path::new(&settings.download_dir),
            task.size_bytes.unwrap_or(0),
        )?;

        let quality = quality.ok_or_else(|| RunError {
            code: "format_unavailable".into(),
            message: "所选清晰度已不可用，请重新解析后再下载。".into(),
        })?;

        if self.engine.ffmpeg_path().is_none() {
            return Err(RunError {
                code: "ffmpeg_missing".into(),
                message: "未找到 ffmpeg，无法合并视频/音频或转换音频。".into(),
            });
        }

        task.status = TaskStatus::Downloading;
        task.downloaded_bytes = 0;
        task.speed_bytes_per_sec = 0.0;
        task.eta_seconds = None;
        if !self
            .db
            .update_task_if_status(task, TaskStatus::Probing)
            .map_err(db_run_error)?
        {
            return Err(cancelled_run_error());
        }
        self.emit_task(task);

        let engine_path = self.engine.yt_dlp_path().ok_or_else(|| RunError {
            code: "engine_missing".into(),
            message: "未找到 yt-dlp 下载引擎。".into(),
        })?;
        let yt_dlp_cache = self.data_dir.join("yt-dlp-cache");
        let _ = std::fs::create_dir_all(&yt_dlp_cache);
        let mut command = Command::new(engine_path);
        command
            .arg("--no-config")
            .arg("--cache-dir")
            .arg(&yt_dlp_cache)
            .arg("--no-playlist")
            .arg("--newline")
            .arg("--no-color")
            .arg("--socket-timeout")
            .arg("30")
            // 请求级重试（单次 HTTP 请求内部），与任务级自动重试不是同一层，固定 5 次即可。
            .arg("--retries")
            .arg("5")
            .arg("--fragment-retries")
            .arg(settings.fragment_retries.to_string())
            .arg("--concurrent-fragments")
            .arg("4")
            .arg("--print")
            .arg("after_move:BILIPOCKET_FILE:%(filepath)s")
            .arg("--progress-template")
            .arg("download:PROGRESS:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed)s|%(progress.eta)s")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .kill_on_drop(true);

        if settings.rate_limit_kbps > 0 {
            command
                .arg("--limit-rate")
                .arg(format!("{}K", settings.rate_limit_kbps));
        }
        if let Some(ffmpeg) = self.engine.ffmpeg_path() {
            command.arg("--ffmpeg-location").arg(ffmpeg);
        }
        if let Some(header) = cookie_header.as_deref() {
            command.arg("--add-header").arg(format!("Cookie: {header}"));
        }
        if !selected_subtitles.is_empty() {
            command
                .arg("--write-subs")
                .arg("--write-auto-subs")
                .arg("--sub-langs")
                .arg(selected_subtitles.join(","))
                .arg("--sub-format")
                .arg(format!("{}/best", settings.subtitle_format))
                .arg("--convert-subs")
                .arg(&settings.subtitle_format);
        }

        // T11：区间下载与断点续传互斥（半截文件不能被误续）。
        if let (Some(start), Some(end)) = (
            task.options.section_start.as_deref(),
            task.options.section_end.as_deref(),
        ) {
            command
                .arg("--download-sections")
                .arg(format!("*{start}-{end}"))
                .arg("--no-continue");
        }

        if quality.audio_only {
            command
                .arg("-f")
                .arg(&task.format_id)
                .arg("--extract-audio")
                .arg("--audio-format")
                .arg("mp3")
                .arg("--audio-quality")
                .arg("320K");
        } else {
            // T15：多选音轨时把附加音频流并入 MKV；未选时行为与原来完全一致。
            let extra_audio = if task.options.audio_track_ids.is_empty() {
                String::new()
            } else {
                format!("+{}", task.options.audio_track_ids.join("+"))
            };
            let selector = match &quality.audio_format_id {
                Some(audio) => format!("{}+{}{}", task.format_id, audio, extra_audio),
                None => format!("{}+bestaudio[ext=m4a]/bestaudio{}", task.format_id, extra_audio),
            };
            command.arg("-f").arg(selector);
            if !extra_audio.is_empty() {
                command.arg("--audio-multistreams");
            }
            command
                .arg("--merge-output-format")
                .arg(if task.container == "mkv" {
                    "mkv"
                } else {
                    "mp4"
                });
        }

        let output_template = temp_dir.join("download.%(ext)s");
        command.arg("-o").arg(output_template);
        command.arg(&task.source_url);

        let mut child = command.spawn().map_err(|error| RunError {
            code: "engine_failed".into(),
            message: format!("无法启动 yt-dlp：{error}"),
        })?;
        if let Some(job) = crate::process_job::attach(&child) {
            self.jobs
                .lock_or_recover("jobs")
                .insert(task.id.clone(), job);
        }
        let _job_guard = JobGuard {
            queue: self,
            task_id: task.id.clone(),
        };
        let stdout = child.stdout.take().ok_or_else(|| RunError {
            code: "engine_failed".into(),
            message: "无法读取 yt-dlp 输出。".into(),
        })?;
        let stderr = child.stderr.take().ok_or_else(|| RunError {
            code: "engine_failed".into(),
            message: "无法读取 yt-dlp 错误输出。".into(),
        })?;

        let stderr_handle = tokio::spawn(async move {
            let mut lines = Vec::new();
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if lines.len() >= 80 {
                    lines.remove(0);
                }
                lines.push(line);
            }
            lines
        });

        let mut reader = BufReader::new(stdout).lines();
        let mut file_path: Option<String> = None;
        let mut last_progress = Instant::now();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(rest) = line.strip_prefix("PROGRESS:") {
                let changed = apply_progress(task, rest);
                if changed && last_progress.elapsed() >= self.progress_interval() {
                    if !self
                        .db
                        .update_task_if_status(task, TaskStatus::Downloading)
                        .map_err(db_run_error)?
                    {
                        return Err(cancelled_run_error());
                    }
                    self.emit_task(task);
                    last_progress = Instant::now();
                }
            } else if let Some(path) = line.strip_prefix("BILIPOCKET_FILE:") {
                file_path = Some(path.trim().to_string());
            }
        }

        let status = child.wait().await.map_err(|error| RunError {
            code: "engine_failed".into(),
            message: format!("等待 yt-dlp 退出失败：{error}"),
        })?;
        let stderr_lines = stderr_handle.await.unwrap_or_default();
        let stderr_text = stderr_lines.join("\n");
        if !status.success() {
            return Err(map_download_error(&stderr_text, status.code()));
        }

        let output = file_path
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .or_else(|| find_downloaded_file(&temp_dir))
            .ok_or_else(|| RunError {
                code: "missing_output".into(),
                message: "下载完成但找不到输出文件。".into(),
            })?;

        task.status = TaskStatus::Muxing;
        task.speed_bytes_per_sec = 0.0;
        task.eta_seconds = None;
        if !self
            .db
            .update_task_if_status(task, TaskStatus::Downloading)
            .map_err(db_run_error)?
        {
            return Err(cancelled_run_error());
        }
        self.emit_task(task);

        task.status = TaskStatus::Extras;
        if !self
            .db
            .update_task_if_status(task, TaskStatus::Muxing)
            .map_err(db_run_error)?
        {
            return Err(cancelled_run_error());
        }
        self.emit_task(task);

        // T12：产物不合格不能标 Completed；不再把读不到大小当成 0 字节继续走。
        crate::postprocess::verify_output(&output, quality.audio_only).map_err(|message| {
            RunError {
                code: "empty_output".into(),
                message,
            }
        })?;
        let file_size = std::fs::metadata(&output)
            .map(|meta| meta.len())
            .unwrap_or(0);
        let extension = output
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("mp4");
        let completed_at = now_ms();
        let vars = files::TemplateVars {
            title: &task.title,
            quality_label: &task.quality_label,
            uploader: &task.uploader,
            bvid: task.bvid.as_deref().unwrap_or(""),
            completed_at_ms: completed_at,
            published_at_ms: task.options.published_at.or(probe.published_at),
            page_index: task.options.page_index,
            page_title: task.options.page_title.as_deref(),
        };
        let destination = files::build_output_path_with(
            Path::new(&settings.download_dir),
            &settings.filename_template,
            &vars,
            extension,
        )
        .map_err(|message| RunError {
            code: "filename_invalid".into(),
            message,
        })?;
        move_file(&output, &destination).map_err(|error| RunError {
            code: "file_error".into(),
            message: format!("无法写入最终文件：{error}"),
        })?;
        let destination_string = destination.to_string_lossy().into_owned();

        task.status = TaskStatus::Completed;
        task.downloaded_bytes = file_size;
        task.size_bytes = Some(file_size);
        task.output_path = Some(destination_string.clone());
        task.completed_at = Some(completed_at);
        task.speed_bytes_per_sec = 0.0;
        task.eta_seconds = None;
        task.error_code = None;
        task.error_message = None;
        if !self
            .db
            .update_task_if_status(task, TaskStatus::Extras)
            .map_err(db_run_error)?
        {
            let _ = std::fs::remove_file(&destination);
            return Err(cancelled_run_error());
        }

        // 落盘后处理全部 best-effort：失败只记 warning，不改任务状态。
        let mut post_warnings: Vec<String> = Vec::new();
        let cover = match crate::postprocess::copy_cover(
            task.cover_path.as_deref(),
            &destination,
            &settings.cover_naming,
            settings.save_cover,
        ) {
            Ok(path) => path,
            Err(error) => {
                log::warn!("封面落盘失败：{error}");
                post_warnings.push(error);
                None
            }
        };
        if settings.save_nfo {
            if let Err(error) = crate::postprocess::write_nfo(
                &destination,
                task,
                &settings.nfo_title_source,
                task.options.published_at.or(probe.published_at),
                cover.as_deref(),
            ) {
                log::warn!("NFO 写入失败：{error}");
                post_warnings.push(error);
            }
        }
        if settings.write_chapters {
            let cid = probe
                .pages
                .iter()
                .find(|page| Some(page.index) == task.options.page_index)
                .or_else(|| probe.pages.first())
                .map(|page| page.cid);
            if let (Some(bvid), Some(cid)) = (task.bvid.clone(), cid) {
                let cookie = cookie_header.clone();
                let chapters = tokio::task::spawn_blocking(move || {
                    crate::bilibili::fetch_view_points(&bvid, cid, cookie.as_deref())
                })
                .await
                .unwrap_or_default();
                match tokio::task::spawn_blocking({
                    let ffmpeg = self.engine.ffmpeg_path();
                    let path = destination.clone();
                    move || crate::postprocess::write_chapters(ffmpeg.as_deref(), &path, &chapters)
                })
                .await
                {
                    Ok(Ok(count)) if count > 0 => log::info!("写入 {count} 个章节"),
                    Ok(Err(error)) => {
                        log::warn!("章节写入失败：{error}");
                        post_warnings.push(error);
                    }
                    _ => {}
                }
            }
        }
        if !post_warnings.is_empty() {
            task.extras_error = Some(
                std::iter::once(task.extras_error.clone().unwrap_or_default())
                    .chain(post_warnings)
                    .filter(|text| !text.is_empty())
                    .collect::<Vec<_>>()
                    .join("；"),
            );
            let _ = self.db.update_task(task);
        }

        let extras = write_extras(
            &temp_dir,
            &destination,
            &selected_subtitles,
            &selected_danmaku,
            danmaku_url.as_deref(),
            &settings.subtitle_format,
        )
        .await;
        if !selected_subtitles.is_empty() || !selected_danmaku.is_empty() {
            let mut messages: Vec<String> = task
                .extras_error
                .clone()
                .filter(|text| !text.is_empty())
                .into_iter()
                .collect();
            messages.extend(extras.errors);
            task.extras_error = if messages.is_empty() {
                None
            } else {
                Some(messages.join("；"))
            };
            if extras.danmaku_count > 0 {
                task.danmaku_count = extras.danmaku_count;
            }
            let _ = self.db.update_task(task);
        }

        let history = HistoryEntry {
            id: Uuid::new_v4().to_string(),
            kind: task.kind,
            task_id: Some(task.id.clone()),
            source_url: task.source_url.clone(),
            bvid: task.bvid.clone(),
            title: task.title.clone(),
            uploader: task.uploader.clone(),
            cover_url: task.cover_url.clone(),
            cover_path: task.cover_path.clone(),
            duration_seconds: task.duration_seconds,
            format_id: task.format_id.clone(),
            quality_label: task.quality_label.clone(),
            container: extension.to_string(),
            size_bytes: Some(file_size),
            output_path: Some(destination_string),
            danmaku_types: task.danmaku_types.clone(),
            danmaku_count: task.danmaku_count,
            subtitle_langs: task.subtitle_langs.clone(),
            extras_error: task.extras_error.clone(),
            completed_at,
            missing_file: false,
        };
        let _ = self.db.insert_history(&history);
        self.emit_task(task);
        let _ = self.app.emit("history://changed", ());
        let _ = std::fs::remove_dir_all(&temp_dir);

        if settings.notify_on_complete {
            let _ = self
                .app
                .notification()
                .builder()
                .title("BiliPocket 下载完成")
                .body(format!("{} · {}", task.title, task.quality_label))
                .show();
        }

        Ok(())
    }

    async fn execute_extras_task(
        &self,
        task: &mut Task,
        settings: &Settings,
        temp_dir: &Path,
        danmaku_url: Option<String>,
        cookie_header: Option<&str>,
    ) -> Result<(), RunError> {
        task.status = TaskStatus::Extras;
        task.speed_bytes_per_sec = 0.0;
        task.eta_seconds = None;
        if !self
            .db
            .update_task_if_status(task, TaskStatus::Probing)
            .map_err(db_run_error)?
        {
            return Err(cancelled_run_error());
        }
        self.emit_task(task);

        let folder = files::build_video_folder(Path::new(&settings.download_dir), &task.title)
            .map_err(|message| RunError {
                code: "file_error".into(),
                message,
            })?;
        let completed_at = now_ms();
        let base = files::template_base(
            &settings.filename_template,
            &task.title,
            &task.quality_label,
            &task.uploader,
            task.bvid.as_deref().unwrap_or(""),
            completed_at,
        );
        let stem = files::resolve_extras_stem(&folder, &base);
        let destination = folder.join(&stem);

        let mut pre_errors = Vec::new();
        let mut retry_code = None;
        if !task.subtitle_langs.is_empty() {
            if let Err(error) = self
                .download_extras_subtitles(task, temp_dir, cookie_header)
                .await
            {
                if is_retryable_error(&error.code) {
                    retry_code = Some(error.code.clone());
                }
                pre_errors.push(error.message);
            }
        }

        let mut result = write_extras(
            temp_dir,
            &destination,
            &task.subtitle_langs,
            &task.danmaku_types,
            danmaku_url.as_deref(),
            &settings.subtitle_format,
        )
        .await;
        if !pre_errors.is_empty() {
            result.errors.splice(0..0, pre_errors);
        }

        if result.written.is_empty() {
            let _ = std::fs::remove_dir(&folder);
            let code = retry_code
                .or(result.failure_code.clone())
                .unwrap_or_else(|| "extras_failed".into());
            return Err(RunError {
                code,
                message: if result.errors.is_empty() {
                    "未能写入任何弹幕或字幕文件。".into()
                } else {
                    result.errors.join("；")
                },
            });
        }

        let size = result
            .written
            .iter()
            .filter_map(|path| std::fs::metadata(path).ok().map(|meta| meta.len()))
            .sum::<u64>();
        let folder_string = folder.to_string_lossy().into_owned();
        task.status = TaskStatus::Completed;
        task.output_path = Some(folder_string.clone());
        task.size_bytes = Some(size);
        task.downloaded_bytes = size;
        task.danmaku_count = result.danmaku_count;
        task.extras_error = if result.errors.is_empty() {
            None
        } else {
            Some(result.errors.join("；"))
        };
        task.completed_at = Some(completed_at);
        task.speed_bytes_per_sec = 0.0;
        task.eta_seconds = None;
        task.error_code = None;
        task.error_message = None;
        if !self
            .db
            .update_task_if_status(task, TaskStatus::Extras)
            .map_err(db_run_error)?
        {
            for path in &result.written {
                let _ = std::fs::remove_file(path);
            }
            let _ = std::fs::remove_dir(&folder);
            return Err(cancelled_run_error());
        }

        let history = HistoryEntry {
            id: Uuid::new_v4().to_string(),
            kind: task.kind,
            task_id: Some(task.id.clone()),
            source_url: task.source_url.clone(),
            bvid: task.bvid.clone(),
            title: task.title.clone(),
            uploader: task.uploader.clone(),
            cover_url: task.cover_url.clone(),
            cover_path: task.cover_path.clone(),
            duration_seconds: task.duration_seconds,
            format_id: task.format_id.clone(),
            quality_label: task.quality_label.clone(),
            container: task.container.clone(),
            size_bytes: Some(size),
            output_path: Some(folder_string),
            danmaku_types: task.danmaku_types.clone(),
            danmaku_count: task.danmaku_count,
            subtitle_langs: task.subtitle_langs.clone(),
            extras_error: task.extras_error.clone(),
            completed_at,
            missing_file: false,
        };
        let _ = self.db.insert_history(&history);
        self.emit_task(task);
        let _ = self.app.emit("history://changed", ());
        let _ = std::fs::remove_dir_all(temp_dir);

        if settings.notify_on_complete {
            let _ = self
                .app
                .notification()
                .builder()
                .title("BiliPocket 弹幕/字幕已保存")
                .body(format!("{} · 附加内容", task.title))
                .show();
        }
        Ok(())
    }

    async fn download_extras_subtitles(
        &self,
        task: &Task,
        temp_dir: &Path,
        cookie_header: Option<&str>,
    ) -> Result<(), RunError> {
        let languages = task
            .subtitle_langs
            .iter()
            .filter(|language| files::valid_sidecar_token(language))
            .map(String::as_str)
            .collect::<Vec<_>>();
        if languages.is_empty() {
            return Err(RunError {
                code: "extras_failed".into(),
                message: "字幕语言名不合法，已跳过。".into(),
            });
        }
        let engine_path = self.engine.yt_dlp_path().ok_or_else(|| RunError {
            code: "engine_missing".into(),
            message: "未找到 yt-dlp 下载引擎。".into(),
        })?;
        let yt_dlp_cache = self.data_dir.join("yt-dlp-cache");
        let _ = std::fs::create_dir_all(&yt_dlp_cache);
        let mut command = Command::new(engine_path);
        command
            .arg("--no-config")
            .arg("--cache-dir")
            .arg(&yt_dlp_cache)
            .arg("--no-playlist")
            .arg("--newline")
            .arg("--no-color")
            .arg("--socket-timeout")
            .arg("30")
            // 同上：请求级重试固定，分片级重试跟随设置。
            .arg("--retries")
            .arg("5")
            .arg("--fragment-retries")
            .arg(self.fragment_retries().to_string())
            .arg("--skip-download")
            .arg("--write-subs")
            .arg("--write-auto-subs")
            .arg("--sub-langs")
            .arg(languages.join(","))
            .arg("--sub-format")
            .arg(format!("{}/best", self.subtitle_format()))
            .arg("--convert-subs")
            .arg(self.subtitle_format())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .kill_on_drop(true);
        if let Some(header) = cookie_header {
            command.arg("--add-header").arg(format!("Cookie: {header}"));
        }
        let output_template = temp_dir.join("download.%(ext)s");
        command.arg("-o").arg(output_template);
        command.arg(&task.source_url);

        let child = command.spawn().map_err(|error| RunError {
            code: "engine_failed".into(),
            message: format!("无法启动 yt-dlp：{error}"),
        })?;
        if let Some(job) = crate::process_job::attach(&child) {
            self.jobs
                .lock_or_recover("jobs")
                .insert(task.id.clone(), job);
        }
        let _job_guard = JobGuard {
            queue: self,
            task_id: task.id.clone(),
        };
        let output = child.wait_with_output().await.map_err(|error| RunError {
            code: "engine_failed".into(),
            message: format!("等待 yt-dlp 退出失败：{error}"),
        })?;
        if output.status.success() {
            return Ok(());
        }
        Err(map_download_error(
            &String::from_utf8_lossy(&output.stderr),
            output.status.code(),
        ))
    }

    fn task_is_active(&self, id: &str) -> bool {
        self.db
            .get_task(id)
            .ok()
            .flatten()
            .map(|task| task.status.is_active())
            .unwrap_or(false)
    }

    fn emit_task(&self, task: &Task) {
        let _ = self.app.emit("tasks://changed", task);
    }
}

fn check_disk_space(directory: &Path, required_bytes: u64) -> Result<(), RunError> {
    const MARGIN_BYTES: u64 = 128 * 1024 * 1024;
    let available = fs2::available_space(directory).map_err(|error| RunError {
        code: "disk_error".into(),
        message: format!("无法读取磁盘剩余空间：{error}"),
    })?;
    let needed = required_bytes.saturating_add(MARGIN_BYTES);
    if available < needed {
        return Err(RunError {
            code: "disk_full".into(),
            message: format!(
                "磁盘空间不足：预计还需要 {}，当前可用 {}。",
                crate::domain::format_size_mb(needed),
                crate::domain::format_size_mb(available)
            ),
        });
    }
    Ok(())
}

fn engine_run_error(error: EngineError) -> RunError {
    RunError {
        code: error.code().to_string(),
        message: error.message(),
    }
}

fn db_run_error(error: crate::db::DbError) -> RunError {
    RunError {
        code: "database".into(),
        message: error.to_string(),
    }
}

fn apply_progress(task: &mut Task, payload: &str) -> bool {
    let mut parts = payload.split('|');
    let downloaded = parse_u64(parts.next());
    let total = parse_u64(parts.next());
    let speed = parse_f64(parts.next());
    let eta = parse_u64(parts.next());
    let mut changed = false;
    if let Some(downloaded) = downloaded {
        if downloaded != task.downloaded_bytes {
            task.downloaded_bytes = downloaded;
            changed = true;
        }
    }
    if let Some(total) = total {
        if total > 0 && task.size_bytes != Some(total) {
            task.size_bytes = Some(total);
            changed = true;
        }
    }
    if let Some(speed) = speed {
        task.speed_bytes_per_sec = speed.max(0.0);
        changed = true;
    }
    if eta != task.eta_seconds {
        task.eta_seconds = eta;
        changed = true;
    }
    changed
}

fn parse_u64(value: Option<&str>) -> Option<u64> {
    let value = value?.trim();
    if value.is_empty() || value == "NA" || value == "None" || value == "N/A" {
        return None;
    }
    value
        .parse::<f64>()
        .ok()
        .map(|value| value.max(0.0) as u64)
        .or_else(|| value.parse::<u64>().ok())
}

fn parse_f64(value: Option<&str>) -> Option<f64> {
    let value = value?.trim();
    if value.is_empty() || value == "NA" || value == "None" || value == "N/A" {
        return None;
    }
    value.parse::<f64>().ok()
}

fn find_downloaded_file(temp_dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(temp_dir).ok()?;
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            !name.ends_with(".part")
                && !name.ends_with(".ytdl")
                && !name.ends_with(".json")
                && !name.ends_with(".srt")
                && !name.ends_with(".xml")
                && !name.ends_with(".ass")
        })
        .max_by_key(|path| std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0))
}

fn move_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if destination.exists() {
        std::fs::remove_file(destination)?;
    }
    match std::fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(_) => {
            let copied = std::fs::copy(source, destination)?;
            let expected = std::fs::metadata(source)?.len();
            if copied != expected {
                let _ = std::fs::remove_file(destination);
                return Err(std::io::Error::other("复制后的文件大小与源文件不一致"));
            }
            std::fs::remove_file(source)?;
            Ok(())
        }
    }
}

async fn write_extras(
    temp_dir: &Path,
    destination: &Path,
    subtitle_langs: &[String],
    danmaku_types: &[String],
    danmaku_url: Option<&str>,
    subtitle_format: &str,
) -> ExtrasWriteResult {
    let mut result = ExtrasWriteResult::default();
    let Some(parent) = destination.parent() else {
        return result;
    };
    let Some(stem) = destination.file_stem().and_then(|value| value.to_str()) else {
        return result;
    };

    for language in subtitle_langs {
        if !files::valid_sidecar_token(language) {
            result
                .errors
                .push(format!("字幕语言名不合法，已跳过：{language}"));
            continue;
        }
        match find_subtitle_file(temp_dir, language, subtitle_format) {
            Some(file) => {
                let target = parent.join(format!("{stem}.{language}.{subtitle_format}"));
                // T09：文件名声明的语言与预期不符时给出提示，不阻断任务。
                if crate::postprocess::subtitle_language_mismatch(&file, language) {
                    result
                        .errors
                        .push(format!("字幕 {language} 的语言可能与所选不一致"));
                }
                match move_file(&file, &target) {
                    Ok(()) => result.written.push(target),
                    Err(error) => result
                        .errors
                        .push(format!("无法写入字幕 {language}：{error}")),
                }
            }
            None => result.errors.push(format!("字幕 {language} 未生成")),
        }
    }

    if danmaku_types.is_empty() {
        return result;
    }
    let Some(url) = danmaku_url.map(str::to_string) else {
        result.errors.push("未能取得弹幕资源。".into());
        return result;
    };
    let fetched = tokio::task::spawn_blocking(move || crate::engine::fetch_danmaku_xml(&url)).await;
    let xml = match fetched {
        Ok(Ok(xml)) => xml,
        Ok(Err(error)) => {
            result.failure_code = Some(error.code().to_string());
            result.errors.push(format!("弹幕：{}", error.message()));
            return result;
        }
        Err(error) => {
            result.errors.push(format!("弹幕任务失败：{error}"));
            return result;
        }
    };
    let filtered = crate::engine::filter_danmaku_xml(&xml, danmaku_types);
    let target = parent.join(format!("{stem}.danmaku.xml"));
    let temp = parent.join(format!(".{stem}.danmaku.xml.{}.tmp", Uuid::new_v4()));
    if let Err(error) = std::fs::write(&temp, &filtered) {
        result.errors.push(format!("无法写入弹幕：{error}"));
        return result;
    }
    match move_file(&temp, &target) {
        Ok(()) => {
            result.danmaku_count = crate::engine::count_danmaku_types(&filtered).values().sum();
            result.written.push(target);
        }
        Err(error) => {
            let _ = std::fs::remove_file(&temp);
            result.errors.push(format!("无法写入弹幕：{error}"));
        }
    }
    result
}

/// T13：随并发数拉长进度事件间隔。抽成纯函数便于单测。
fn progress_interval_for(active: usize) -> Duration {
    let millis = match active {
        0..=5 => 500,
        6..=15 => 900,
        _ => 1500,
    };
    Duration::from_millis(millis)
}

fn find_subtitle_file(directory: &Path, language: &str, format: &str) -> Option<PathBuf> {
    let marker = format!(".{language}.");
    std::fs::read_dir(directory)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            name.contains(&marker)
                && (name.ends_with(&format!(".{format}"))
                    || name.ends_with(".srt")
                    || name.ends_with(".ass")
                    || name.ends_with(".vtt"))
        })
}

fn map_download_error(stderr: &str, exit_code: Option<i32>) -> RunError {
    let lower = stderr.to_ascii_lowercase();
    let code = if crate::engine::is_risk_control_text(&lower) {
        "risk_control"
    } else if lower.contains("ffmpeg") {
        "ffmpeg_missing"
    } else if lower.contains("premium") || lower.contains("大会员") || lower.contains("vip") {
        "vip_required"
    } else if lower.contains("login") || lower.contains("sessdata") {
        "auth_required"
    } else if lower.contains("no space") || lower.contains("disk") {
        "disk_full"
    } else if lower.contains("403") {
        "permission_denied"
    } else if lower.contains("404") || lower.contains("not found") {
        "not_found"
    } else if lower.contains("timed out") || lower.contains("timeout") {
        "timeout"
    } else if lower.contains("rate") || lower.contains("too many") {
        "rate_limited"
    } else {
        "download_failed"
    };
    let message = if code == "risk_control" {
        log::warn!("yt-dlp 下载命中风控：{}", stderr.trim());
        "B 站触发了访问频率校验（HTTP 412 / -352）。请减少同时进行的解析与下载，稍后重试。".to_string()
    } else {
        let message = stderr
            .lines()
            .filter(|line| !line.trim().is_empty())
            .take(4)
            .collect::<Vec<_>>()
            .join("\n");
        if message.is_empty() {
            format!("yt-dlp 下载失败（退出码 {:?}）", exit_code)
        } else {
            message
        }
    };
    RunError {
        code: code.into(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_progress, check_disk_space, find_subtitle_file, is_retryable_error,
        map_download_error, parse_u64, plan_failure, progress_interval_for, retry_delay_seconds,
        write_extras, FailurePlan, RetryPolicy,
    };
    use crate::domain::{Task, TaskKind, TaskStatus};

    fn task() -> Task {
        Task {
            options: Default::default(),
            id: "task".into(),
            kind: TaskKind::Video,
            source_url: "https://www.bilibili.com/video/BV1xx411c7mD".into(),
            bvid: None,
            title: "测试".into(),
            uploader: "UP".into(),
            cover_url: None,
            cover_path: None,
            duration_seconds: None,
            format_id: "30080".into(),
            quality_label: "1080P".into(),
            container: "mp4".into(),
            size_bytes: None,
            downloaded_bytes: 0,
            speed_bytes_per_sec: 0.0,
            eta_seconds: None,
            status: TaskStatus::Downloading,
            error_code: None,
            error_message: None,
            extras_error: None,
            output_path: None,
            temp_dir: None,
            danmaku_types: vec![],
            danmaku_count: 0,
            subtitle_langs: vec![],
            engine_version: None,
            attempt: 0,
            created_at: 0,
            queued_at: None,
            started_at: None,
            completed_at: None,
            retry_at: None,
        }
    }

    #[tokio::test]
    async fn writes_selected_subtitles_and_reports_missing_ones() {
        let directory =
            std::env::temp_dir().join(format!("bilipocket_extras_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let output_dir = directory.join("output");
        std::fs::create_dir_all(&output_dir).unwrap();
        std::fs::write(directory.join("download.zh-Hans.srt"), b"subtitle").unwrap();
        let destination = output_dir.join("视频 [1080P].mp4");
        let result = write_extras(
            &directory,
            &destination,
            &["zh-Hans".into(), "en".into(), "../evil".into()],
            &[],
            None,
            "srt",
        )
        .await;
        assert!(output_dir.join("视频 [1080P].zh-Hans.srt").is_file());
        assert!(result
            .errors
            .iter()
            .any(|error| error.contains("字幕 en 未生成")));
        assert!(result.errors.iter().any(|error| error.contains("不合法")));
        assert_eq!(result.written.len(), 1);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn classifies_retryable_failures_and_backoff() {
        assert!(is_retryable_error("timeout"));
        assert!(is_retryable_error("network"));
        assert!(is_retryable_error("rate_limited"));
        assert!(is_retryable_error("risk_control"));
        assert!(!is_retryable_error("auth_required"));
        assert!(!is_retryable_error("vip_required"));
        assert!(!is_retryable_error("disk_full"));
        assert!(!is_retryable_error("not_found"));
        assert_eq!(retry_delay_seconds("timeout", 1, 15), 15);
        assert_eq!(retry_delay_seconds("timeout", 2, 15), 30);
        assert_eq!(retry_delay_seconds("timeout", 3, 15), 60);
        // 风控用更长的阶梯，且不会越界。
        assert_eq!(retry_delay_seconds("risk_control", 1, 15), 30);
        assert_eq!(retry_delay_seconds("risk_control", 2, 15), 90);
        assert_eq!(retry_delay_seconds("risk_control", 3, 15), 180);
        assert_eq!(retry_delay_seconds("risk_control", 9, 15), 180);
    }

    #[test]
    fn plans_automatic_retry_then_terminal_state() {
        let policy = RetryPolicy::default();
        assert_eq!(
            plan_failure(0, "timeout", &policy),
            FailurePlan::Retry {
                attempt: 1,
                delay_seconds: 15
            }
        );
        assert_eq!(
            plan_failure(2, "network", &policy),
            FailurePlan::Retry {
                attempt: 3,
                delay_seconds: 60
            }
        );
        assert_eq!(
            plan_failure(3, "timeout", &policy),
            FailurePlan::Terminal {
                status: TaskStatus::Failed
            }
        );
        assert_eq!(
            plan_failure(1, "auth_required", &policy),
            FailurePlan::Terminal {
                status: TaskStatus::Paused
            }
        );
        assert_eq!(
            plan_failure(0, "disk_full", &policy),
            FailurePlan::Terminal {
                status: TaskStatus::Failed
            }
        );
    }

    #[test]
    fn pauses_after_risk_control_retries_run_out() {
        let policy = RetryPolicy::default();
        assert_eq!(
            plan_failure(0, "risk_control", &policy),
            FailurePlan::Retry {
                attempt: 1,
                delay_seconds: 30
            }
        );
        assert_eq!(
            plan_failure(2, "risk_control", &policy),
            FailurePlan::Retry {
                attempt: 3,
                delay_seconds: 180
            }
        );
        assert_eq!(
            plan_failure(3, "risk_control", &policy),
            FailurePlan::Terminal {
                status: TaskStatus::Paused
            }
        );
    }

    #[test]
    fn honours_custom_retry_policy() {
        // 0 次 = 立即终止，不做任何自动重试。
        let none = RetryPolicy {
            max: 0,
            base_seconds: 15,
        };
        assert_eq!(
            plan_failure(0, "timeout", &none),
            FailurePlan::Terminal {
                status: TaskStatus::Failed
            }
        );

        // 自定义基础间隔按 2 的幂放大。
        let short = RetryPolicy {
            max: 3,
            base_seconds: 5,
        };
        assert_eq!(
            plan_failure(0, "timeout", &short),
            FailurePlan::Retry {
                attempt: 1,
                delay_seconds: 5
            }
        );
        assert_eq!(
            plan_failure(1, "timeout", &short),
            FailurePlan::Retry {
                attempt: 2,
                delay_seconds: 10
            }
        );
        assert_eq!(
            plan_failure(2, "timeout", &short),
            FailurePlan::Retry {
                attempt: 3,
                delay_seconds: 20
            }
        );

        // 风控阶梯同样跟随基础间隔。
        assert_eq!(retry_delay_seconds("risk_control", 1, 5), 10);
        assert_eq!(retry_delay_seconds("risk_control", 3, 5), 60);

        // 5 次上限时第 5 次仍可重试，第 6 次终止。
        let five = RetryPolicy {
            max: 5,
            base_seconds: 15,
        };
        assert!(matches!(
            plan_failure(4, "network", &five),
            FailurePlan::Retry { attempt: 5, .. }
        ));
        assert!(matches!(
            plan_failure(5, "network", &five),
            FailurePlan::Terminal { .. }
        ));
    }

    #[test]
    fn maps_risk_control_stderr_to_its_own_code() {
        let direct = map_download_error("ERROR: HTTP Error 412: Precondition Failed", Some(1));
        assert_eq!(direct.code, "risk_control");
        assert!(direct.message.contains("访问频率校验"));
        // 原始 stderr 不应直接抛给用户。
        assert!(!direct.message.contains("Precondition"));

        let body = map_download_error("ERROR: code=-352, 请求过于频繁", Some(1));
        assert_eq!(body.code, "risk_control");

        let voucher = map_download_error("got v_voucher required", Some(1));
        assert_eq!(voucher.code, "risk_control");

        // 普通 404 不应被误判。
        assert_eq!(
            map_download_error("ERROR: HTTP Error 404: Not Found", Some(1)).code,
            "not_found"
        );
        // 只有数字 352 出现（如字节数）时不能被误判。
        assert_eq!(
            map_download_error("downloaded 352000 bytes, retrying", Some(1)).code,
            "download_failed"
        );
    }

    #[test]
    fn rejects_insufficient_disk_space() {
        let directory = std::env::temp_dir();
        let error = check_disk_space(&directory, u64::MAX).expect_err("should be insufficient");
        assert_eq!(error.code, "disk_full");
        assert!(check_disk_space(&directory, 0).is_ok());
    }

    #[test]
    fn parses_progress_values() {
        assert_eq!(parse_u64(Some("NA")), None);
        assert_eq!(parse_u64(Some("1024.5")), Some(1024));
        let mut task = task();
        assert!(apply_progress(&mut task, "1024|2048|512.5|3"));
        assert_eq!(task.downloaded_bytes, 1024);
        assert_eq!(task.size_bytes, Some(2048));
        assert_eq!(task.speed_bytes_per_sec, 512.5);
        assert_eq!(task.eta_seconds, Some(3));
    }

    #[test]
    fn maps_download_errors() {
        assert_eq!(
            map_download_error("ERROR: ffmpeg not found", Some(1)).code,
            "ffmpeg_missing"
        );
        assert_eq!(
            map_download_error("ERROR: login required", Some(1)).code,
            "auth_required"
        );
        assert_eq!(
            map_download_error("ERROR: 403 Forbidden", Some(1)).code,
            "permission_denied"
        );
    }

    #[test]
    fn progress_interval_stretches_as_concurrency_grows() {
        // 单任务 500ms 即 2 事件/秒，远低于 10 事件/秒的验收上限。
        assert_eq!(progress_interval_for(0).as_millis(), 500);
        assert_eq!(progress_interval_for(5).as_millis(), 500);
        assert_eq!(progress_interval_for(6).as_millis(), 900);
        assert_eq!(progress_interval_for(15).as_millis(), 900);
        assert_eq!(progress_interval_for(16).as_millis(), 1500);
        // 任何档位都必须满足「每任务每秒不超过 10 个进度事件」。
        for active in [0usize, 1, 5, 6, 15, 16, 50, 200] {
            let per_second = 1000.0 / progress_interval_for(active).as_millis() as f64;
            assert!(per_second <= 10.0, "{active} 并发时每任务 {per_second} 事件/秒");
        }
    }

    #[test]
    fn finds_subtitle_in_every_supported_format() {
        let dir = std::env::temp_dir().join(format!("bp_subs_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        for extension in ["srt", "ass", "vtt"] {
            let path = dir.join(format!("视频.zh-Hans.{extension}"));
            std::fs::write(&path, b"x").unwrap();
            let found = find_subtitle_file(&dir, "zh-Hans", extension);
            assert_eq!(found.as_deref(), Some(path.as_path()), "找不到 {extension}");
            std::fs::remove_file(&path).unwrap();
        }
        assert!(find_subtitle_file(&dir, "zh-Hans", "srt").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn subtitle_lookup_ignores_other_languages() {
        let dir = std::env::temp_dir().join(format!("bp_subs_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("视频.en.srt"), b"x").unwrap();
        assert!(find_subtitle_file(&dir, "zh-Hans", "srt").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
