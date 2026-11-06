use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const DEFAULT_FILENAME_TEMPLATE: &str = "{title} [{quality}]";
pub const DEFAULT_QUALITY: &str = "auto";
pub const DEFAULT_RETRY_MAX: u32 = 3;
pub const DEFAULT_RETRY_BASE_SECONDS: u32 = 15;
pub const DEFAULT_FRAGMENT_RETRIES: u32 = 5;
pub const MAX_RETRY_MAX: u32 = 10;
/// 限速上限，与前端 settings-schema.js 的 rateLimitKbps.max 保持一致。
pub const MAX_RATE_LIMIT_KBPS: u32 = 102_400;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    // 前 8 个字段原本是必填：旧版前端少发任一字段都会让整份反序列化失败并重置设置。
    // 全部补 serde 默认值后，缺失项交给 validate() 回退，不再整份丢弃。
    #[serde(default)]
    pub theme: String,
    #[serde(default)]
    pub download_dir: String,
    #[serde(default)]
    pub max_concurrent: u32,
    #[serde(default)]
    pub rate_limit_kbps: u32,
    #[serde(default)]
    pub filename_template: String,
    #[serde(default)]
    pub preferred_quality: String,
    #[serde(default = "default_true")]
    pub notify_on_complete: bool,
    #[serde(default)]
    pub minimize_to_tray: bool,
    #[serde(default = "default_true")]
    pub default_danmaku: bool,
    #[serde(default = "default_true")]
    pub default_subtitles: bool,
    #[serde(default)]
    pub authorized_accepted: bool,
    /// 任务失败后自动重启的次数（0 表示不自动重试）。
    #[serde(default = "default_retry_max")]
    pub retry_max: u32,
    /// 自动重试的基础退避秒数，实际间隔按 2 的幂递增。
    #[serde(default = "default_retry_base_seconds")]
    pub retry_base_seconds: u32,
    /// 交给 yt-dlp 的分片级重试次数，与任务级重试不是同一层。
    #[serde(default = "default_fragment_retries")]
    pub fragment_retries: u32,
    #[serde(default)]
    pub save_cover: bool,
    #[serde(default = "default_cover_naming")]
    pub cover_naming: String,
    #[serde(default = "default_subtitle_format")]
    pub subtitle_format: String,
    #[serde(default)]
    pub write_chapters: bool,
    #[serde(default)]
    pub save_nfo: bool,
    #[serde(default = "default_nfo_title_source")]
    pub nfo_title_source: String,
}

fn default_cover_naming() -> String {
    "poster".into()
}

fn default_subtitle_format() -> String {
    "srt".into()
}

fn default_nfo_title_source() -> String {
    "video".into()
}

fn default_true() -> bool {
    true
}

fn default_retry_max() -> u32 {
    DEFAULT_RETRY_MAX
}

fn default_retry_base_seconds() -> u32 {
    DEFAULT_RETRY_BASE_SECONDS
}

fn default_fragment_retries() -> u32 {
    DEFAULT_FRAGMENT_RETRIES
}

impl Settings {
    pub fn defaults(download_dir: String) -> Self {
        Self {
            theme: "light".into(),
            download_dir,
            max_concurrent: 2,
            rate_limit_kbps: 0,
            filename_template: DEFAULT_FILENAME_TEMPLATE.into(),
            preferred_quality: DEFAULT_QUALITY.into(),
            notify_on_complete: true,
            minimize_to_tray: false,
            default_danmaku: true,
            default_subtitles: true,
            authorized_accepted: false,
            retry_max: DEFAULT_RETRY_MAX,
            retry_base_seconds: DEFAULT_RETRY_BASE_SECONDS,
            fragment_retries: DEFAULT_FRAGMENT_RETRIES,
            save_cover: false,
            cover_naming: default_cover_naming(),
            subtitle_format: default_subtitle_format(),
            write_chapters: false,
            save_nfo: false,
            nfo_title_source: default_nfo_title_source(),
        }
    }

    pub fn validate(&mut self, fallback_dir: &str) {
        if !matches!(self.theme.as_str(), "light" | "dark" | "system") {
            self.theme = "light".into();
        }
        if self.download_dir.trim().is_empty() {
            self.download_dir = fallback_dir.to_string();
        }
        self.max_concurrent = self.max_concurrent.clamp(1, 5);
        // 与前端 schema 保持同一上限；此前只有 mock 端有这条限制。
        self.rate_limit_kbps = self.rate_limit_kbps.min(MAX_RATE_LIMIT_KBPS);
        if self.filename_template.trim().is_empty() {
            self.filename_template = DEFAULT_FILENAME_TEMPLATE.into();
        }
        if self.preferred_quality.trim().is_empty() {
            self.preferred_quality = DEFAULT_QUALITY.into();
        }
        self.retry_max = self.retry_max.min(MAX_RETRY_MAX);
        self.retry_base_seconds = self.retry_base_seconds.clamp(3, 300);
        self.fragment_retries = self.fragment_retries.min(20);
        if !matches!(self.cover_naming.as_str(), "poster" | "stem") {
            self.cover_naming = default_cover_naming();
        }
        if !matches!(self.subtitle_format.as_str(), "srt" | "ass") {
            self.subtitle_format = default_subtitle_format();
        }
        if !matches!(self.nfo_title_source.as_str(), "video" | "page" | "combined") {
            self.nfo_title_source = default_nfo_title_source();
        }
    }
}

/// 任务级可选参数，整体序列化到 `tasks.options_json` 一列。
/// 新增字段一律走这里，避免每次都要改 DB 列索引。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOptions {
    #[serde(default)]
    pub page_index: Option<u32>,
    #[serde(default)]
    pub page_title: Option<String>,
    #[serde(default)]
    pub published_at: Option<i64>,
    #[serde(default)]
    pub section_start: Option<String>,
    #[serde(default)]
    pub section_end: Option<String>,
    #[serde(default)]
    pub audio_track_ids: Vec<String>,
}

/// 分 P 序号上限：B 站的实际分 P 数远小于此，超出即视为脏数据。
const MAX_PAGE_INDEX: u32 = 10_000;
/// 分 P 标题只用于文件名模板与 NFO，超长直接截断而不是报错。
const MAX_PAGE_TITLE_CHARS: usize = 200;
/// 附加音轨条数与单条 ID 长度上限，防止把超长字符串拼进 yt-dlp 的 `-f` 选择器。
const MAX_AUDIO_TRACKS: usize = 16;
const MAX_AUDIO_TRACK_ID_CHARS: usize = 32;

impl TaskOptions {
    /// 入队前的形状校验。
    /// 这些值会进文件名模板、NFO 与 yt-dlp 的 `-f` 选择器，脏值会变成下游难懂的报错。
    /// 只校验形状，不校验归属（例如音轨是否真属于该视频，那需要额外一次 probe）。
    pub fn validate(&mut self) -> Result<(), &'static str> {
        if let Some(index) = self.page_index {
            if !(1..=MAX_PAGE_INDEX).contains(&index) {
                return Err("分 P 序号超出范围");
            }
        }
        if let Some(title) = self.page_title.as_mut() {
            *title = title.chars().take(MAX_PAGE_TITLE_CHARS).collect();
        }
        // 负数或 0 会让 NFO 与文件名里的日期算出错误结果，直接丢弃而不是保留。
        if self.published_at.is_some_and(|value| value <= 0) {
            self.published_at = None;
        }
        if self.audio_track_ids.len() > MAX_AUDIO_TRACKS {
            return Err("附加音轨数量超过上限");
        }
        for id in &self.audio_track_ids {
            if !is_valid_audio_track_id(id) {
                return Err("附加音轨 ID 格式不合法");
            }
        }
        let mut seen = std::collections::HashSet::new();
        self.audio_track_ids.retain(|id| seen.insert(id.clone()));
        Ok(())
    }
}

fn is_valid_audio_track_id(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_AUDIO_TRACK_ID_CHARS
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '-')
}

/// 一个 BV 下的分 P（来自 view 接口的 `pages`，不是遍历抓取）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPage {
    pub index: u32,
    pub cid: u64,
    pub title: String,
    pub duration_seconds: Option<u64>,
}

/// 合集（`ugc_season`）里的一个独立视频。
/// 注意它与 `VideoPage` 不是一回事：分 P 同属一个 BV，合集里每一条是**独立 BV**。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonEpisode {
    pub bvid: String,
    pub title: String,
    #[serde(default)]
    pub duration_seconds: Option<u64>,
    #[serde(default)]
    pub cover_url: Option<String>,
    /// B 站给的 `pubdate`，单位是秒。
    #[serde(default)]
    pub published_at: Option<i64>,
    /// 所属分段标题（如「议事」）；合集只有一个分段时可能为空。
    #[serde(default)]
    pub section: String,
}

/// 合集元信息。`episodes` 已按 bvid 去重，顺序沿用接口返回顺序。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonInfo {
    pub id: i64,
    pub title: String,
    pub episodes: Vec<SeasonEpisode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    pub id: String,
    pub label: String,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskKind {
    #[default]
    Video,
    Extras,
}

impl TaskKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Video => "video",
            Self::Extras => "extras",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "extras" => Self::Extras,
            _ => Self::Video,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Queued,
    Probing,
    Downloading,
    Muxing,
    /// 视频任务写入字幕/弹幕的阶段；`TaskKind::Extras` 任务也停在此状态。
    Extras,
    Paused,
    Failed,
    Completed,
    Cancelled,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Probing => "probing",
            Self::Downloading => "downloading",
            Self::Muxing => "muxing",
            Self::Extras => "extras",
            Self::Paused => "paused",
            Self::Failed => "failed",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "probing" => Self::Probing,
            "downloading" => Self::Downloading,
            "muxing" => Self::Muxing,
            "extras" => Self::Extras,
            "paused" => Self::Paused,
            "failed" => Self::Failed,
            "completed" => Self::Completed,
            "cancelled" => Self::Cancelled,
            _ => Self::Queued,
        }
    }

    pub fn is_active(self) -> bool {
        matches!(
            self,
            Self::Probing | Self::Downloading | Self::Muxing | Self::Extras
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    #[serde(default)]
    pub kind: TaskKind,
    pub source_url: String,
    pub bvid: Option<String>,
    pub title: String,
    pub uploader: String,
    pub cover_url: Option<String>,
    #[serde(default)]
    pub cover_path: Option<String>,
    pub duration_seconds: Option<u64>,
    pub format_id: String,
    pub quality_label: String,
    pub container: String,
    pub size_bytes: Option<u64>,
    pub downloaded_bytes: u64,
    pub speed_bytes_per_sec: f64,
    pub eta_seconds: Option<u64>,
    pub status: TaskStatus,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    #[serde(default)]
    pub extras_error: Option<String>,
    pub output_path: Option<String>,
    pub temp_dir: Option<String>,
    pub danmaku_types: Vec<String>,
    pub danmaku_count: u64,
    pub subtitle_langs: Vec<String>,
    pub engine_version: Option<String>,
    pub attempt: u32,
    pub created_at: i64,
    pub queued_at: Option<i64>,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    #[serde(default)]
    pub retry_at: Option<i64>,
    #[serde(default)]
    pub options: TaskOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSpec {
    #[serde(default)]
    pub kind: TaskKind,
    pub source_url: String,
    pub bvid: Option<String>,
    pub format_id: String,
    pub quality_label: String,
    pub container: Option<String>,
    pub title: Option<String>,
    pub uploader: Option<String>,
    pub cover_url: Option<String>,
    #[serde(default)]
    pub cover_path: Option<String>,
    pub duration_seconds: Option<u64>,
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub danmaku_types: Vec<String>,
    #[serde(default)]
    pub danmaku_count: u64,
    #[serde(default)]
    pub subtitle_langs: Vec<String>,
    #[serde(default)]
    pub options: TaskOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    #[serde(default)]
    pub kind: TaskKind,
    pub task_id: Option<String>,
    pub source_url: String,
    pub bvid: Option<String>,
    pub title: String,
    pub uploader: String,
    pub cover_url: Option<String>,
    #[serde(default)]
    pub cover_path: Option<String>,
    pub duration_seconds: Option<u64>,
    pub format_id: String,
    pub quality_label: String,
    pub container: String,
    pub size_bytes: Option<u64>,
    pub output_path: Option<String>,
    pub danmaku_types: Vec<String>,
    pub danmaku_count: u64,
    pub subtitle_langs: Vec<String>,
    #[serde(default)]
    pub extras_error: Option<String>,
    pub completed_at: i64,
    #[serde(default)]
    pub missing_file: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityOption {
    pub format_id: String,
    pub audio_format_id: Option<String>,
    pub label: String,
    pub resolution: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub codec: String,
    pub container: String,
    pub size_bytes: Option<u64>,
    pub audio_only: bool,
    pub dynamic_range: Option<String>,
    pub note: Option<String>,
    pub accessible: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleTrack {
    pub id: String,
    pub label: String,
    pub ext: String,
    pub accessible: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DanmakuInfo {
    pub available: bool,
    pub count: Option<u64>,
    pub counts: BTreeMap<String, u64>,
    pub url: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProbe {
    pub source_url: String,
    pub bvid: Option<String>,
    pub title: String,
    pub uploader: String,
    pub cover_url: Option<String>,
    #[serde(default)]
    pub cover_path: Option<String>,
    pub duration_seconds: Option<u64>,
    #[serde(default)]
    pub view_count: Option<u64>,
    #[serde(default)]
    pub api_danmaku_count: Option<u64>,
    #[serde(default)]
    pub published_at: Option<i64>,
    pub description: Option<String>,
    pub qualities: Vec<QualityOption>,
    pub subtitles: Vec<SubtitleTrack>,
    pub danmaku: DanmakuInfo,
    pub recommended_quality: Option<String>,
    pub engine_version: String,
    pub warnings: Vec<String>,
    /// 同一 BV 下的分 P 列表；单 P 视频为空数组。
    #[serde(default)]
    pub pages: Vec<VideoPage>,
    #[serde(default)]
    pub audio_tracks: Vec<AudioTrack>,
    /// 该视频所属合集；不属于任何合集时为 None。
    #[serde(default)]
    pub season: Option<SeasonInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub available: bool,
    pub yt_dlp_version: Option<String>,
    pub ffmpeg_version: Option<String>,
    pub engine_path: Option<String>,
    pub message: Option<String>,
    /// 结构化问题与建议动作；正常时不返回。`detail` 必须是固定文案，不含路径。
    #[serde(default)]
    pub problem: Option<EngineProblem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineProblem {
    pub code: String,
    pub detail: String,
    pub remedy: Remedy,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Remedy {
    /// 重新跑一次完整性校验。
    Recheck,
    /// 让用户换一个可写的下载目录。
    PickDir,
    /// 只能靠重装/查看排查文档。
    Reinstall,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub mid: u64,
    pub name: String,
    pub avatar_url: Option<String>,
    pub vip: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub logged_in: bool,
    pub account: Option<AccountInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QrLoginStart {
    pub qrcode_key: String,
    pub qr_svg: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QrLoginPoll {
    pub status: String,
    pub message: Option<String>,
    pub account: Option<AccountInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelResult {
    pub task: Task,
    pub partial_deleted: bool,
    pub delete_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub file_deleted: bool,
    pub file_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub settings: Settings,
    pub tasks: Vec<Task>,
    pub history: Vec<HistoryEntry>,
    pub engine: EngineInfo,
    pub auth: AuthStatus,
    pub data_dir: String,
    pub autostart: bool,
    pub portable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl CommandError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CommandError {}

pub type CommandResult<T> = Result<T, CommandError>;

pub fn format_size_mb(bytes: u64) -> String {
    let mb = bytes as f64 / 1_000_000.0;
    if mb >= 1024.0 {
        format!("{:.2} GB", mb / 1024.0)
    } else {
        format!("{mb:.1} MB")
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

pub fn normalize_bvid(value: &str) -> Option<String> {
    let start = value.find("BV")?;
    let candidate = &value[start..];
    if candidate.len() < 12 {
        return None;
    }
    let id = &candidate[..12];
    id.chars()
        .all(|character| character.is_ascii_alphanumeric())
        .then(|| id.to_string())
}

pub fn format_label_from_dimensions(height: Option<u32>, fps: Option<f64>) -> Option<String> {
    let height = height?;
    let base = if height >= 4320 {
        "8K"
    } else if height >= 2160 {
        "4K"
    } else if height >= 1440 {
        "1440P"
    } else if height >= 1080 {
        "1080P"
    } else if height >= 720 {
        "720P"
    } else if height >= 480 {
        "480P"
    } else if height >= 360 {
        "360P"
    } else {
        return Some(format!("{height}P"));
    };

    if matches!(base, "1080P" | "720P") && fps.map(|value| value >= 50.0).unwrap_or(false) {
        Some(format!("{base}60"))
    } else {
        Some(base.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::TaskOptions;

    #[test]
    fn rejects_page_index_out_of_range() {
        let mut options = TaskOptions {
            page_index: Some(0),
            ..Default::default()
        };
        assert!(options.validate().is_err(), "0 不是合法分 P 序号");

        let mut too_large = TaskOptions {
            page_index: Some(10_001),
            ..Default::default()
        };
        assert!(too_large.validate().is_err());

        let mut ok = TaskOptions {
            page_index: Some(3),
            ..Default::default()
        };
        assert!(ok.validate().is_ok());
    }

    #[test]
    fn rejects_malformed_audio_track_ids() {
        for bad in ["30080 +--exec", "", "   ", "音轨", "a".repeat(33).as_str()] {
            let mut options = TaskOptions {
                audio_track_ids: vec![bad.to_string()],
                ..Default::default()
            };
            assert!(options.validate().is_err(), "{bad:?} 应被拒绝");
        }

        let mut ok = TaskOptions {
            audio_track_ids: vec!["30280".into(), "30250_alt".into()],
            ..Default::default()
        };
        assert!(ok.validate().is_ok());
    }

    #[test]
    fn rejects_too_many_audio_tracks_and_deduplicates() {
        let mut too_many = TaskOptions {
            audio_track_ids: (0..17).map(|index| format!("track{index}")).collect(),
            ..Default::default()
        };
        assert!(too_many.validate().is_err());

        let mut duplicated = TaskOptions {
            audio_track_ids: vec!["30280".into(), "30280".into()],
            ..Default::default()
        };
        assert!(duplicated.validate().is_ok());
        assert_eq!(duplicated.audio_track_ids, vec!["30280".to_string()]);
    }

    #[test]
    fn drops_non_positive_published_at_and_truncates_long_title() {
        let mut options = TaskOptions {
            published_at: Some(-1),
            page_title: Some("长".repeat(300)),
            ..Default::default()
        };
        assert!(options.validate().is_ok());
        assert_eq!(options.published_at, None, "非正数时间戳应被丢弃");
        assert_eq!(options.page_title.unwrap().chars().count(), 200);
    }
}
