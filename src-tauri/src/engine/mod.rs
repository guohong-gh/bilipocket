use flate2::read::{DeflateDecoder, GzDecoder, ZlibDecoder};
use reqwest::header::{HeaderValue, ACCEPT_ENCODING, CONTENT_ENCODING, REFERER, USER_AGENT};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{RwLock, RwLockReadGuard},
    time::Duration,
};
use thiserror::Error;

use crate::domain::{
    format_label_from_dimensions, normalize_bvid, AudioTrack, DanmakuInfo, EngineInfo,
    EngineProblem, QualityOption, Remedy, SubtitleTrack, VideoProbe,
};

const YTDLP_ENV: &str = "BILIPOCKET_YTDLP";
const FFMPEG_ENV: &str = "BILIPOCKET_FFMPEG";
#[cfg(debug_assertions)]
const DANMAKU_FIXTURE_ENV: &str = "BILIPOCKET_DANMAKU_FIXTURE";
const MAX_DANMAKU_BYTES: usize = 20 * 1024 * 1024;
const ENGINE_MANIFEST: &str = include_str!("../../binaries/ENGINE_MANIFEST.json");

#[derive(Debug, Deserialize)]
struct Manifest {
    engines: Vec<ManifestEngine>,
}

#[derive(Debug, Deserialize)]
struct ManifestEngine {
    name: String,
    sha256: String,
}

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("download engine is not available")]
    Missing,
    #[error("invalid video URL: {0}")]
    InvalidUrl(String),
    #[error("{code}: {message}")]
    Failed { code: String, message: String },
}

impl EngineError {
    pub fn code(&self) -> &str {
        match self {
            Self::Missing => "engine_missing",
            Self::InvalidUrl(_) => "invalid_url",
            Self::Failed { code, .. } => code,
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Missing => "未找到 yt-dlp。请先安装开发引擎或把 yt-dlp 放入应用目录。".into(),
            Self::InvalidUrl(message) => format!("仅接受 Bilibili 视频链接：{message}"),
            Self::Failed { message, .. } => message.clone(),
        }
    }
}

struct EngineInner {
    yt_dlp: Option<PathBuf>,
    ffmpeg: Option<PathBuf>,
    yt_dlp_version: Option<String>,
    ffmpeg_version: Option<String>,
    integrity_message: Option<String>,
}

/// 引擎句柄。内部状态可在运行期整体替换（重新校验后无需重启），对外仍是 `Arc<Engine>`。
pub struct Engine {
    inner: RwLock<EngineInner>,
}

fn discover_inner(resource_dir: Option<&Path>) -> EngineInner {
    let dev_override = cfg!(debug_assertions);
    let mut integrity_message = None;
    let yt_dlp = discover_binary(
        YTDLP_ENV,
        "yt-dlp",
        &["yt-dlp.exe", "yt-dlp", "yt-dlp-x86_64-pc-windows-msvc.exe"],
        resource_dir,
    )
    .and_then(|path| {
        if dev_override {
            return Some(path);
        }
        match verify_binary(&path, "yt-dlp") {
            Ok(()) => Some(path),
            Err(error) => {
                integrity_message = Some(error);
                None
            }
        }
    });
    let ffmpeg = discover_binary(
        FFMPEG_ENV,
        "ffmpeg",
        &["ffmpeg.exe", "ffmpeg", "ffmpeg-x86_64-pc-windows-msvc.exe"],
        resource_dir,
    )
    .and_then(|path| {
        if dev_override {
            return Some(path);
        }
        match verify_binary(&path, "ffmpeg") {
            Ok(()) => Some(path),
            Err(error) => {
                integrity_message.get_or_insert(error);
                None
            }
        }
    });
    let yt_dlp_version = yt_dlp.as_deref().and_then(read_version);
    let ffmpeg_version = ffmpeg.as_deref().and_then(read_version);
    EngineInner {
        yt_dlp,
        ffmpeg,
        yt_dlp_version,
        ffmpeg_version,
        integrity_message,
    }
}

/// 结构化问题。`detail` 只用固定文案，不带路径——诊断导出会把该结构原样序列化。
fn engine_problem(inner: &EngineInner) -> Option<EngineProblem> {
    let checksum_failed = inner.integrity_message.is_some();
    if inner.yt_dlp.is_none() {
        return Some(EngineProblem {
            code: if checksum_failed {
                "checksumFailed"
            } else {
                "engineMissing"
            }
            .into(),
            detail: if checksum_failed {
                "下载引擎未通过完整性校验，已禁用。"
            } else {
                "未找到下载引擎 yt-dlp。"
            }
            .into(),
            remedy: if checksum_failed {
                Remedy::Recheck
            } else {
                Remedy::Reinstall
            },
        });
    }
    if inner.ffmpeg.is_none() {
        return Some(EngineProblem {
            code: if checksum_failed {
                "checksumFailed"
            } else {
                "ffmpegMissing"
            }
            .into(),
            detail: if checksum_failed {
                "ffmpeg 未通过完整性校验，已禁用。"
            } else {
                "未找到 ffmpeg，音视频合并与音频转换暂不可用。"
            }
            .into(),
            remedy: if checksum_failed {
                Remedy::Recheck
            } else {
                Remedy::Reinstall
            },
        });
    }
    None
}

impl Engine {
    pub fn discover(resource_dir: Option<&Path>) -> Self {
        Self {
            inner: RwLock::new(discover_inner(resource_dir)),
        }
    }

    #[cfg(test)]
    pub fn for_test(yt_dlp: PathBuf) -> Self {
        Self {
            inner: RwLock::new(EngineInner {
                yt_dlp_version: read_version(&yt_dlp),
                yt_dlp: Some(yt_dlp),
                ffmpeg: None,
                ffmpeg_version: None,
                integrity_message: None,
            }),
        }
    }

    #[cfg(test)]
    pub fn for_test_paths(yt_dlp: PathBuf, ffmpeg: Option<PathBuf>) -> Self {
        let yt_dlp_version = read_version(&yt_dlp);
        let ffmpeg_version = ffmpeg.as_deref().and_then(read_version);
        Self {
            inner: RwLock::new(EngineInner {
                yt_dlp: Some(yt_dlp),
                ffmpeg,
                yt_dlp_version,
                ffmpeg_version,
                integrity_message: None,
            }),
        }
    }

    fn read(&self) -> RwLockReadGuard<'_, EngineInner> {
        self.inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 重新执行发现与完整性校验，并替换当前引擎状态。已在运行的进程不受影响。
    pub fn refresh(&self, resource_dir: Option<&Path>) -> EngineInfo {
        let fresh = discover_inner(resource_dir);
        {
            let mut guard = self
                .inner
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *guard = fresh;
        }
        self.info()
    }

    pub fn info(&self) -> EngineInfo {
        let inner = self.read();
        EngineInfo {
            available: inner.yt_dlp.is_some(),
            yt_dlp_version: inner.yt_dlp_version.clone(),
            ffmpeg_version: inner.ffmpeg_version.clone(),
            engine_path: inner.yt_dlp.as_ref().map(|path| {
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            }),
            message: if inner.yt_dlp.is_some() {
                if inner.ffmpeg.is_some() {
                    inner.integrity_message.clone()
                } else {
                    inner
                        .integrity_message
                        .clone()
                        .or_else(|| Some("未找到 ffmpeg，视频合并和音频转换暂不可用。".into()))
                }
            } else {
                inner
                    .integrity_message
                    .clone()
                    .or_else(|| Some("未找到 yt-dlp 下载引擎。".into()))
            },
            problem: engine_problem(&inner),
        }
    }

    pub fn yt_dlp_path(&self) -> Option<PathBuf> {
        self.read().yt_dlp.clone()
    }

    pub fn ffmpeg_path(&self) -> Option<PathBuf> {
        self.read().ffmpeg.clone()
    }

    pub fn yt_dlp_version(&self) -> Option<String> {
        self.read().yt_dlp_version.clone()
    }

    pub fn probe_command(
        &self,
        raw_url: &str,
        cookie_header: Option<&str>,
        cache_dir: Option<&Path>,
    ) -> Result<std::process::Command, EngineError> {
        let url = normalize_bilibili_url(raw_url)?;
        let executable = self.yt_dlp_path().ok_or(EngineError::Missing)?;
        let mut command = std::process::Command::new(executable);
        command.args([
            "--no-playlist",
            "--skip-download",
            "--dump-single-json",
            "--no-color",
            "--no-progress",
            "--socket-timeout",
            "20",
            "--retries",
            "2",
            "--extractor-retries",
            "1",
        ]);
        if let Some(header) = cookie_header {
            command.arg("--add-header").arg(format!("Cookie: {header}"));
        }
        if let Some(cache_dir) = cache_dir {
            let _ = std::fs::create_dir_all(cache_dir);
            command.arg("--cache-dir").arg(cache_dir);
        }
        command
            .arg(&url)
            .env("PYTHONIOENCODING", "utf-8")
            .env("NO_COLOR", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        Ok(command)
    }

    pub fn finish_probe(
        &self,
        output: std::process::Output,
        source_url: &str,
        with_danmaku_stats: bool,
    ) -> Result<VideoProbe, EngineError> {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() {
            return Err(map_probe_failure(&stderr, output.status.code()));
        }

        let value: Value =
            serde_json::from_str(stdout.trim()).map_err(|error| EngineError::Failed {
                code: "parse_failed".into(),
                message: format!("yt-dlp 返回的元数据无法解析：{error}"),
            })?;
        let mut probe = parse_probe_json(
            &value,
            source_url,
            self.yt_dlp_version().unwrap_or_default(),
            &stderr,
        )?;
        if with_danmaku_stats {
            if let Some(danmaku_url) = probe.danmaku.url.clone() {
                match fetch_danmaku_xml(&danmaku_url) {
                    Ok(xml) => {
                        let counts = count_danmaku_types(&xml);
                        let total = counts.values().sum::<u64>();
                        probe.danmaku.counts = counts;
                        probe.danmaku.count = if total > 0 { Some(total) } else { None };
                    }
                    Err(error) => {
                        log::warn!("弹幕统计失败：{}", error.message());
                        probe.danmaku.reason =
                            Some("无法获取弹幕统计，仍可在下载时尝试写入。".into());
                    }
                }
            }
        }
        Ok(probe)
    }

    pub fn probe_with_cookies(
        &self,
        raw_url: &str,
        cookie_header: Option<&str>,
        cache_dir: Option<&Path>,
    ) -> Result<VideoProbe, EngineError> {
        let url = normalize_bilibili_url(raw_url)?;
        let mut command = self.probe_command(&url, cookie_header, cache_dir)?;
        let output = command.output().map_err(|error| EngineError::Failed {
            code: "engine_failed".into(),
            message: format!("无法启动 yt-dlp：{error}"),
        })?;
        self.finish_probe(output, &url, true)
    }
}

fn discover_binary(
    _env_name: &str,
    _name: &str,
    file_names: &[&str],
    resource_dir: Option<&Path>,
) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Ok(value) = env::var(_env_name) {
        let path = PathBuf::from(&value);
        if path.is_file() {
            return Some(path);
        }
    }

    let mut candidates = Vec::new();
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            for file in file_names {
                candidates.push(parent.join(file));
                candidates.push(parent.join("binaries").join(file));
                candidates.push(parent.join("_up_").join("binaries").join(file));
            }
        }
    }
    if let Some(resource_dir) = resource_dir {
        for file in file_names {
            candidates.push(resource_dir.join("binaries").join(file));
            candidates.push(resource_dir.join("_up_").join("binaries").join(file));
        }
    }
    #[cfg(debug_assertions)]
    {
        if let Ok(current) = env::current_dir() {
            for root in [current.clone(), current.join(".."), current.join("../..")] {
                for file in file_names {
                    candidates.push(root.join("binaries").join(file));
                    candidates.push(root.join(".engine").join("venv").join("Scripts").join(file));
                    candidates.push(root.join(".engine").join(file));
                }
            }
        }
    }
    for candidate in candidates {
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    #[cfg(debug_assertions)]
    {
        let path = env::var_os("PATH")?;
        for directory in env::split_paths(&path) {
            for file in file_names {
                let candidate = directory.join(file);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn expected_hash(name: &str) -> Option<String> {
    let manifest: Manifest = serde_json::from_str(ENGINE_MANIFEST).ok()?;
    manifest
        .engines
        .into_iter()
        .find(|engine| engine.name == name)
        .map(|engine| engine.sha256)
}

fn sha256_file(path: &Path) -> Result<String, std::io::Error> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn verify_binary(path: &Path, name: &str) -> Result<(), String> {
    let expected = expected_hash(name)
        .ok_or_else(|| format!("引擎清单缺少 {name} 的校验值，已禁用该引擎。"))?;
    let actual = sha256_file(path).map_err(|error| format!("无法读取 {name} 引擎：{error}"))?;
    if actual.eq_ignore_ascii_case(&expected) {
        Ok(())
    } else {
        Err(format!(
            "{name} 引擎校验失败，文件可能被篡改或版本不匹配；请重新安装 BiliPocket。"
        ))
    }
}

fn read_version(path: &Path) -> Option<String> {
    for argument in ["--version", "-version"] {
        let output = Command::new(path)
            .arg(argument)
            .env("PYTHONIOENCODING", "utf-8")
            .output()
            .ok()?;
        if !output.status.success() {
            continue;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let text = if stdout.trim().is_empty() {
            stderr
        } else {
            stdout
        };
        let version = text
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(|line| {
                line.replace("ffmpeg version ", "")
                    .replace(" Copyright (c) 2000-2024 the FFmpeg developers", "")
                    .trim()
                    .to_string()
            })
            .filter(|line| !line.is_empty());
        if version.is_some() {
            return version;
        }
    }
    None
}

pub fn normalize_bilibili_url(raw: &str) -> Result<String, EngineError> {
    let input = raw.trim();
    if input.is_empty() {
        return Err(EngineError::InvalidUrl("链接为空".into()));
    }
    let candidate = if input.starts_with("BV") || input.starts_with("av") {
        format!("https://www.bilibili.com/video/{input}")
    } else if input.to_ascii_lowercase().starts_with("http://")
        || input.to_ascii_lowercase().starts_with("https://")
    {
        input.to_string()
    } else {
        format!("https://{input}")
    };

    let parsed =
        url::Url::parse(&candidate).map_err(|error| EngineError::InvalidUrl(error.to_string()))?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let allowed = host == "bilibili.com"
        || host.ends_with(".bilibili.com")
        || host == "b23.tv"
        || host.ends_with(".b23.tv");
    if !allowed {
        return Err(EngineError::InvalidUrl("不是 Bilibili 视频域名".into()));
    }
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(EngineError::InvalidUrl("仅支持 HTTP/HTTPS".into()));
    }
    Ok(candidate)
}

/// 平台侧频率校验的文本特征。只做识别与提示，不做任何规避。
pub(crate) fn is_risk_control_text(lower: &str) -> bool {
    lower.contains("precondition failed")
        || lower.contains("http error 412")
        || lower.contains("-352")
        || lower.contains("v_voucher")
}

fn map_probe_failure(stderr: &str, exit_code: Option<i32>) -> EngineError {
    let text = stderr.trim();
    let lower = text.to_ascii_lowercase();
    let code = if is_risk_control_text(&lower) {
        "risk_control"
    } else if lower.contains("premium") || lower.contains("大会员") || lower.contains("vip") {
        "vip_required"
    } else if lower.contains("login") || lower.contains("sessdata") {
        "auth_required"
    } else if lower.contains("not found") || lower.contains("404") || lower.contains("不存在") {
        "not_found"
    } else if lower.contains("geo") || lower.contains("region") || lower.contains("地区") {
        "geo_blocked"
    } else if lower.contains("rate") || lower.contains("too many") {
        "rate_limited"
    } else if lower.contains("timed out") || lower.contains("timeout") {
        "timeout"
    } else {
        "engine_failed"
    };
    let message = if code == "risk_control" {
        "B 站触发了访问频率校验（HTTP 412 / -352）。请减少同时进行的解析与下载，稍后重试。"
            .to_string()
    } else {
        let message = text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .take(4)
            .collect::<Vec<_>>()
            .join("\n");
        if message.is_empty() {
            format!("yt-dlp 失败（退出码 {:?}）", exit_code)
        } else {
            message
        }
    };
    if code == "risk_control" {
        log::warn!("yt-dlp 命中风控：{text}");
    }
    EngineError::Failed {
        code: code.into(),
        message,
    }
}

fn parse_probe_json(
    value: &Value,
    source_url: &str,
    engine_version: String,
    stderr: &str,
) -> Result<VideoProbe, EngineError> {
    if value.get("_type").and_then(Value::as_str) == Some("playlist") {
        return Err(EngineError::Failed {
            code: "unsupported".into(),
            message: "当前版本只支持单条视频，不支持合集或播放列表。".into(),
        });
    }

    let formats = value
        .get("formats")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if formats.is_empty() {
        return Err(EngineError::Failed {
            code: "no_formats".into(),
            message: "yt-dlp 没有返回可下载的格式。".into(),
        });
    }

    let parsed_formats = formats
        .iter()
        .filter_map(parse_format)
        .collect::<Vec<FormatEntry>>();
    let best_audio = best_audio_format(&parsed_formats);
    let audio_size = best_audio.and_then(|audio| audio.size_bytes);
    let mut groups: BTreeMap<String, Vec<&FormatEntry>> = BTreeMap::new();
    for format in parsed_formats.iter().filter(|format| !format.audio_only) {
        let label = format_label_from_dimensions(format.height, format.fps).unwrap_or_else(|| {
            format
                .height
                .map(|height| format!("{height}P"))
                .unwrap_or_else(|| "未知".into())
        });
        let key = format!(
            "{}|{}",
            label,
            format.dynamic_range.clone().unwrap_or_default()
        );
        groups.entry(key).or_default().push(format);
    }

    let mut qualities = groups
        .into_values()
        .filter_map(|candidates| {
            let chosen = candidates.into_iter().max_by(|left, right| {
                codec_preference(&left.codec)
                    .cmp(&codec_preference(&right.codec))
                    .then(
                        left.tbr
                            .unwrap_or_default()
                            .total_cmp(&right.tbr.unwrap_or_default()),
                    )
            })?;
            let label =
                format_label_from_dimensions(chosen.height, chosen.fps).unwrap_or_else(|| {
                    chosen
                        .height
                        .map(|height| format!("{height}P"))
                        .unwrap_or_else(|| "未知".into())
                });
            let label = if chosen.dynamic_range.as_deref() == Some("DV") {
                format!("{label} 杜比")
            } else if chosen.dynamic_range.as_deref() == Some("HDR10") {
                format!("{label} HDR")
            } else {
                label
            };
            let size_bytes = chosen.size_bytes.map(|size| size + audio_size.unwrap_or(0));
            Some(QualityOption {
                format_id: chosen.format_id.clone(),
                audio_format_id: best_audio.map(|audio| audio.format_id.clone()),
                label,
                resolution: chosen.resolution.clone(),
                width: chosen.width,
                height: chosen.height,
                fps: chosen.fps,
                codec: chosen.codec.clone(),
                container: chosen.container.clone(),
                size_bytes,
                audio_only: false,
                dynamic_range: chosen.dynamic_range.clone(),
                note: chosen.note.clone(),
                accessible: true,
                reason: None,
            })
        })
        .collect::<Vec<_>>();

    qualities.sort_by(|left, right| {
        right
            .height
            .unwrap_or_default()
            .cmp(&left.height.unwrap_or_default())
            .then(
                right
                    .fps
                    .unwrap_or_default()
                    .total_cmp(&left.fps.unwrap_or_default()),
            )
            .then(left.label.cmp(&right.label))
    });

    for (label, height, reason) in parse_missing_formats(stderr) {
        if qualities.iter().any(|quality| quality.label == label) {
            continue;
        }
        let index = qualities
            .iter()
            .position(|quality| quality.audio_only || quality.height.unwrap_or_default() < height)
            .unwrap_or_else(|| {
                qualities
                    .iter()
                    .position(|quality| quality.audio_only)
                    .unwrap_or(qualities.len())
            });
        qualities.insert(
            index,
            QualityOption {
                format_id: format!("locked-{}", label.replace(' ', "-")),
                audio_format_id: None,
                label,
                resolution: None,
                width: None,
                height: Some(height),
                fps: None,
                codec: "locked".into(),
                container: "mp4".into(),
                size_bytes: None,
                audio_only: false,
                dynamic_range: None,
                note: Some("需要账号权限".into()),
                accessible: false,
                reason: Some(reason.to_string()),
            },
        );
    }

    if let Some(audio) = best_audio {
        qualities.push(QualityOption {
            format_id: audio.format_id.clone(),
            audio_format_id: None,
            label: "仅音频".into(),
            resolution: None,
            width: None,
            height: None,
            fps: None,
            codec: audio.codec.clone(),
            container: "mp3".into(),
            size_bytes: audio.size_bytes,
            audio_only: true,
            dynamic_range: None,
            note: audio.note.clone(),
            accessible: true,
            reason: None,
        });
    }

    if qualities.is_empty() {
        return Err(EngineError::Failed {
            code: "no_formats".into(),
            message: "没有可用的视频或音频格式。".into(),
        });
    }

    let subtitles = parse_subtitles(value.get("subtitles"));
    let danmaku = parse_danmaku(value.get("subtitles"));
    let recommended_quality = qualities
        .iter()
        .find(|quality| quality.label.starts_with("1080P"))
        .or_else(|| qualities.iter().find(|quality| !quality.audio_only))
        .or_else(|| qualities.first())
        .map(|quality| quality.format_id.clone());

    let bvid = value
        .get("id")
        .and_then(Value::as_str)
        .and_then(normalize_bvid)
        .or_else(|| {
            value
                .get("webpage_url")
                .and_then(Value::as_str)
                .and_then(extract_bvid)
        });

    Ok(VideoProbe {
        pages: Vec::new(),
        audio_tracks: parse_audio_tracks(value),
        // 合集由 B 站 view 接口提供，yt-dlp 这条路径没有该信息。
        season: None,
        source_url: value
            .get("webpage_url")
            .and_then(Value::as_str)
            .unwrap_or(source_url)
            .to_string(),
        bvid,
        title: value
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("未命名视频")
            .to_string(),
        uploader: value
            .get("uploader")
            .and_then(Value::as_str)
            .or_else(|| value.get("channel").and_then(Value::as_str))
            .unwrap_or("未知 UP 主")
            .to_string(),
        cover_url: value
            .get("thumbnail")
            .and_then(Value::as_str)
            .map(str::to_string),
        cover_path: None,
        duration_seconds: value.get("duration").and_then(Value::as_u64),
        view_count: value.get("view_count").and_then(Value::as_u64),
        api_danmaku_count: None,
        published_at: None,
        description: value
            .get("description")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(str::to_string),
        qualities,
        subtitles,
        danmaku,
        recommended_quality,
        engine_version,
        warnings: parse_warnings(stderr),
    })
}

fn extract_bvid(url: &str) -> Option<String> {
    normalize_bvid(url)
}

/// T15：从 yt-dlp 的 formats 里挑出带语言标签的纯音频流，去重后供 UI 多选。
fn parse_audio_tracks(value: &Value) -> Vec<AudioTrack> {
    let Some(formats) = value.get("formats").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut tracks: Vec<AudioTrack> = Vec::new();
    for format in formats {
        let Some(id) = format.get("format_id").and_then(Value::as_str) else {
            continue;
        };
        let language = format
            .get("language")
            .and_then(Value::as_str)
            .filter(|lang| !lang.is_empty() && *lang != "none");
        if language.is_none() {
            continue;
        }
        // 只收录纯音频流；视频流里的 language 字段没有意义。
        if format
            .get("vcodec")
            .and_then(Value::as_str)
            .unwrap_or("none")
            != "none"
        {
            continue;
        }
        let label = format
            .get("format")
            .and_then(Value::as_str)
            .or_else(|| format.get("format_note").and_then(Value::as_str))
            .unwrap_or(id)
            .to_string();
        if tracks.iter().any(|track| track.id == id) {
            continue;
        }
        tracks.push(AudioTrack {
            id: id.to_string(),
            label,
            language: language.map(str::to_string),
        });
    }
    tracks
}

fn parse_warnings(stderr: &str) -> Vec<String> {
    stderr
        .lines()
        .filter(|line| line.contains("WARNING:") || line.contains("Format(s)"))
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .take(10)
        .collect()
}

fn parse_missing_formats(stderr: &str) -> Vec<(String, u32, &'static str)> {
    let Some(line) = stderr
        .lines()
        .find(|line| line.contains("Format(s)") && line.contains("are missing"))
    else {
        return Vec::new();
    };
    let Some(names) = line
        .split("Format(s)")
        .nth(1)
        .and_then(|value| value.split("are missing").next())
    else {
        return Vec::new();
    };

    let mut missing = Vec::new();
    for raw_name in names.split(',') {
        let name = raw_name.trim();
        if name.is_empty() {
            continue;
        }
        let classified = if name.contains("8K") {
            Some(("8K".to_string(), 4320, "大会员专享"))
        } else if name.contains("4K") {
            Some(("4K".to_string(), 2160, "大会员专享"))
        } else if name.contains("HDR") {
            Some(("HDR".to_string(), 2160, "大会员专享"))
        } else if name.contains("杜比") || name.to_ascii_lowercase().contains("dolby") {
            Some(("杜比".to_string(), 2160, "大会员专享"))
        } else if name.contains("1080P") && (name.contains("60") || name.contains("高帧率")) {
            Some(("1080P60".to_string(), 1080, "大会员专享"))
        } else if name.contains("1080P") && (name.contains("高码率") || name.contains('+')) {
            Some(("1080P+".to_string(), 1080, "大会员专享"))
        } else if name.contains("1080P") {
            Some(("1080P".to_string(), 1080, "登录后可下载"))
        } else if name.contains("720P") {
            Some(("720P".to_string(), 720, "当前账号不可用"))
        } else if name.contains("480P") {
            Some(("480P".to_string(), 480, "当前账号不可用"))
        } else if name.contains("360P") {
            Some(("360P".to_string(), 360, "当前账号不可用"))
        } else {
            None
        };
        if let Some(entry) = classified {
            if !missing.iter().any(|(label, _, _)| label == &entry.0) {
                missing.push(entry);
            }
        }
    }
    missing.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    missing
}

fn parse_subtitles(value: Option<&Value>) -> Vec<SubtitleTrack> {
    let Some(object) = value.and_then(Value::as_object) else {
        return Vec::new();
    };
    object
        .iter()
        .filter(|(language, _)| language.as_str() != "danmaku")
        .filter_map(|(language, entries)| {
            let entry = entries.as_array()?.first()?;
            let ext = entry.get("ext").and_then(Value::as_str).unwrap_or("srt");
            Some(SubtitleTrack {
                id: language.clone(),
                label: subtitle_label(language),
                ext: ext.to_string(),
                accessible: true,
                reason: None,
            })
        })
        .collect()
}

fn parse_danmaku(value: Option<&Value>) -> DanmakuInfo {
    let object = value.and_then(Value::as_object);
    let available = object
        .map(|object| object.contains_key("danmaku"))
        .unwrap_or(false);
    let url = object
        .and_then(|object| object.get("danmaku"))
        .and_then(Value::as_array)
        .and_then(|entries| entries.first())
        .and_then(|entry| entry.get("url"))
        .and_then(Value::as_str)
        .map(str::to_string);
    DanmakuInfo {
        available,
        count: None,
        counts: BTreeMap::new(),
        url,
        reason: if available {
            None
        } else {
            Some("未能取得弹幕资源。".into())
        },
    }
}

pub fn fetch_danmaku_xml(url: &str) -> Result<String, EngineError> {
    #[cfg(debug_assertions)]
    if let Ok(path) = env::var(DANMAKU_FIXTURE_ENV) {
        let bytes = std::fs::read(&path).map_err(|error| EngineError::Failed {
            code: "danmaku_fixture".into(),
            message: format!("无法读取弹幕测试文件：{error}"),
        })?;
        return decode_danmaku_body(&bytes, "");
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|error| EngineError::Failed {
            code: "network".into(),
            message: format!("无法创建弹幕请求：{error}"),
        })?;
    let response = client
        .get(url)
        .header(
            USER_AGENT,
            HeaderValue::from_static("BiliPocket/0.7 (+local desktop client)"),
        )
        .header(
            REFERER,
            HeaderValue::from_static("https://www.bilibili.com/"),
        )
        .header(ACCEPT_ENCODING, HeaderValue::from_static("identity"))
        .send()
        .map_err(|error| EngineError::Failed {
            code: "network".into(),
            message: format!("无法获取弹幕：{error}"),
        })?;
    if !response.status().is_success() {
        return Err(EngineError::Failed {
            code: "network".into(),
            message: format!("弹幕接口返回 HTTP {}", response.status()),
        });
    }
    if response
        .content_length()
        .map(|length| length > MAX_DANMAKU_BYTES as u64)
        .unwrap_or(false)
    {
        return Err(danmaku_decode_error("弹幕数据超过大小限制"));
    }
    let encoding = response
        .headers()
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let bytes = response.bytes().map_err(|error| EngineError::Failed {
        code: "network".into(),
        message: format!("无法读取弹幕内容：{error}"),
    })?;
    decode_danmaku_body(&bytes, &encoding)
}

pub fn decode_danmaku_body(bytes: &[u8], encoding: &str) -> Result<String, EngineError> {
    if bytes.len() > MAX_DANMAKU_BYTES {
        return Err(danmaku_decode_error("弹幕数据超过大小限制"));
    }
    if let Some(xml) = std::str::from_utf8(bytes)
        .ok()
        .and_then(normalize_danmaku_xml)
    {
        return Ok(xml);
    }

    let encoding = encoding.to_ascii_lowercase();
    if encoding.contains("gzip") {
        if let Some(xml) = decode_reader(GzDecoder::new(bytes)) {
            return Ok(xml);
        }
    }
    if let Some(xml) = decode_reader(DeflateDecoder::new(bytes)) {
        return Ok(xml);
    }
    if let Some(xml) = decode_reader(ZlibDecoder::new(bytes)) {
        return Ok(xml);
    }
    if !encoding.contains("gzip") {
        if let Some(xml) = decode_reader(GzDecoder::new(bytes)) {
            return Ok(xml);
        }
    }
    Err(danmaku_decode_error("弹幕数据格式无法识别"))
}

fn decode_reader<R: Read>(reader: R) -> Option<String> {
    let mut output = Vec::new();
    reader
        .take(MAX_DANMAKU_BYTES as u64 + 1)
        .read_to_end(&mut output)
        .ok()?;
    if output.len() > MAX_DANMAKU_BYTES {
        return None;
    }
    std::str::from_utf8(&output)
        .ok()
        .and_then(normalize_danmaku_xml)
}

fn normalize_danmaku_xml(text: &str) -> Option<String> {
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    (trimmed.starts_with('<') && trimmed.contains("</i>")).then(|| trimmed.to_string())
}

fn danmaku_decode_error(message: &str) -> EngineError {
    EngineError::Failed {
        code: "danmaku_decode".into(),
        message: message.to_string(),
    }
}

pub fn count_danmaku_types(xml: &str) -> BTreeMap<String, u64> {
    let mut counts = BTreeMap::new();
    for segment in xml.split("<d p=\"").skip(1) {
        let Some(parameters) = segment.split('"').next() else {
            continue;
        };
        let Some(raw_type) = parameters.split(',').next() else {
            continue;
        };
        let Some(kind) = danmaku_type_id(raw_type.trim()) else {
            continue;
        };
        *counts.entry(kind.to_string()).or_insert(0) += 1;
    }
    counts
}

pub fn filter_danmaku_xml(xml: &str, selected: &[String]) -> String {
    let selected = selected
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let mut output = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?><i>");
    for segment in xml.split("<d p=\"").skip(1) {
        let Some(parameters) = segment.split('"').next() else {
            continue;
        };
        let Some(raw_type) = parameters.split(',').next() else {
            continue;
        };
        let Some(kind) = danmaku_type_id(raw_type.trim()) else {
            continue;
        };
        if !selected.contains(kind) {
            continue;
        }
        let Some(end) = segment.find("</d>") else {
            continue;
        };
        output.push_str("<d p=\"");
        output.push_str(&segment[..end + 4]);
    }
    output.push_str("</i>");
    output
}

fn danmaku_type_id(raw: &str) -> Option<&'static str> {
    match raw {
        "1" => Some("scroll"),
        "4" => Some("bottom"),
        "5" => Some("top"),
        "6" => Some("reverse"),
        "7" | "8" => Some("advanced"),
        _ => None,
    }
}

fn subtitle_label(language: &str) -> String {
    match language {
        "zh-Hans" | "zh-CN" | "zh" | "ai-zh" => "中文".into(),
        "zh-Hant" | "zh-TW" => "繁體中文".into(),
        "en" | "en-US" => "English".into(),
        "ja" | "jp" => "日本語".into(),
        other => other.to_string(),
    }
}

#[derive(Debug, Clone)]
struct FormatEntry {
    format_id: String,
    ext: String,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<f64>,
    codec: String,
    size_bytes: Option<u64>,
    dynamic_range: Option<String>,
    note: Option<String>,
    audio_only: bool,
    tbr: Option<f64>,
    resolution: Option<String>,
    container: String,
}

fn parse_format(value: &Value) -> Option<FormatEntry> {
    let format_id = value.get("format_id").and_then(Value::as_str)?.to_string();
    let vcodec = value
        .get("vcodec")
        .and_then(Value::as_str)
        .unwrap_or("none");
    let acodec = value
        .get("acodec")
        .and_then(Value::as_str)
        .unwrap_or("none");
    let audio_only = vcodec == "none" && acodec != "none";
    if vcodec == "none" && acodec == "none" {
        return None;
    }
    let ext = value.get("ext").and_then(Value::as_str).unwrap_or("mp4");
    let container = if audio_only {
        "mp3"
    } else if ext == "mp4" {
        "mp4"
    } else {
        "mkv"
    };
    let size_bytes = value
        .get("filesize")
        .and_then(Value::as_u64)
        .or_else(|| value.get("filesize_approx").and_then(Value::as_u64));
    let width = value
        .get("width")
        .and_then(Value::as_u64)
        .map(|value| value as u32);
    let height = value
        .get("height")
        .and_then(Value::as_u64)
        .map(|value| value as u32);
    Some(FormatEntry {
        format_id,
        ext: ext.to_string(),
        width,
        height,
        fps: value.get("fps").and_then(Value::as_f64),
        codec: if audio_only {
            acodec.to_string()
        } else {
            vcodec.to_string()
        },
        size_bytes,
        dynamic_range: value
            .get("dynamic_range")
            .and_then(Value::as_str)
            .map(str::to_string),
        note: value
            .get("format_note")
            .and_then(Value::as_str)
            .or_else(|| value.get("format").and_then(Value::as_str))
            .map(str::to_string),
        audio_only,
        tbr: value.get("tbr").and_then(Value::as_f64),
        resolution: value
            .get("resolution")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| match (width, height) {
                (Some(width), Some(height)) => Some(format!("{width}x{height}")),
                _ => None,
            }),
        container: container.to_string(),
    })
}

fn best_audio_format(formats: &[FormatEntry]) -> Option<&FormatEntry> {
    formats
        .iter()
        .filter(|format| format.audio_only)
        .max_by(|left, right| {
            audio_preference(left).cmp(&audio_preference(right)).then(
                left.tbr
                    .unwrap_or_default()
                    .total_cmp(&right.tbr.unwrap_or_default()),
            )
        })
}

fn audio_preference(format: &FormatEntry) -> u8 {
    match format.ext.as_str() {
        "m4a" => 3,
        "mp4" => 2,
        "mp3" => 1,
        _ => 0,
    }
}

fn codec_preference(codec: &str) -> u8 {
    let codec = codec.to_ascii_lowercase();
    if codec.starts_with("avc") || codec.starts_with("h264") {
        4
    } else if codec.starts_with("hev") || codec.starts_with("hvc") || codec.starts_with("hevc") {
        3
    } else if codec.starts_with("av01") {
        2
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::json!({
            "id": "BV1xx411c7mD",
            "title": "测试视频",
            "uploader": "测试 UP",
            "duration": 120,
            "thumbnail": "https://i0.hdslb.com/test.jpg",
            "webpage_url": "https://www.bilibili.com/video/BV1xx411c7mD",
            "formats": [
                {"format_id": "30216", "ext": "m4a", "vcodec": "none", "acodec": "mp4a.40.2", "filesize": 1000, "tbr": 69.0},
                {"format_id": "30016", "ext": "mp4", "width": 640, "height": 360, "fps": 30, "vcodec": "avc1.64001E", "acodec": "none", "filesize": 2000, "tbr": 300.0},
                {"format_id": "30080", "ext": "mp4", "width": 1920, "height": 1080, "fps": 30, "vcodec": "avc1.640028", "acodec": "none", "filesize": 5000, "tbr": 1500.0},
                {"format_id": "30120", "ext": "mp4", "width": 3840, "height": 2160, "fps": 30, "vcodec": "hev1.1.6.L120", "acodec": "none", "filesize": 8000, "tbr": 4000.0}
            ],
            "subtitles": {
                "zh-Hans": [{"ext": "srt"}],
                "en": [{"ext": "srt"}],
                "danmaku": [{"ext": "xml", "url": "https://comment.bilibili.com/123.xml"}]
            }
        })
    }

    #[test]
    fn parses_supported_formats_and_subtitles() {
        let probe = parse_probe_json(
            &fixture(),
            "https://www.bilibili.com/video/BV1xx411c7mD",
            "test".into(),
            "",
        )
        .unwrap();
        assert_eq!(probe.title, "测试视频");
        assert_eq!(probe.bvid.as_deref(), Some("BV1xx411c7mD"));
        assert!(probe.subtitles.iter().any(|track| track.id == "zh-Hans"));
        assert!(probe.danmaku.available);
        assert_eq!(
            probe.danmaku.url.as_deref(),
            Some("https://comment.bilibili.com/123.xml")
        );
        let labels = probe
            .qualities
            .iter()
            .map(|quality| quality.label.as_str())
            .collect::<Vec<_>>();
        assert_eq!(labels, vec!["4K", "1080P", "360P", "仅音频"]);
        let four_k = probe.qualities.first().unwrap();
        assert!(four_k.size_bytes.unwrap() > 8000);
        assert_eq!(probe.recommended_quality.as_deref(), Some("30080"));
    }

    #[test]
    fn validates_bilibili_urls_only() {
        assert!(normalize_bilibili_url("BV1xx411c7mD").is_ok());
        assert!(normalize_bilibili_url("https://www.bilibili.com/video/BV1xx411c7mD").is_ok());
        assert!(normalize_bilibili_url("https://b23.tv/abc").is_ok());
        assert!(normalize_bilibili_url("https://example.com/video/BV1xx411c7mD").is_err());
    }

    #[test]
    fn engine_problem_covers_missing_and_checksum_cases() {
        let empty = |integrity: Option<&str>| EngineInner {
            yt_dlp: None,
            ffmpeg: None,
            yt_dlp_version: None,
            ffmpeg_version: None,
            integrity_message: integrity.map(str::to_string),
        };

        let missing = engine_problem(&empty(None)).unwrap();
        assert_eq!(missing.code, "engineMissing");
        assert_eq!(missing.remedy, Remedy::Reinstall);

        // 校验失败走 Recheck，因为用户可能刚把文件放回去。
        let checksum = engine_problem(&empty(Some("hash mismatch"))).unwrap();
        assert_eq!(checksum.code, "checksumFailed");
        assert_eq!(checksum.remedy, Remedy::Recheck);
        assert!(
            !checksum.detail.contains("hash mismatch"),
            "detail 必须是固定文案"
        );
    }

    #[test]
    fn info_reports_ffmpeg_problem_with_reinstall_remedy() {
        let engine = Engine::for_test(PathBuf::from("yt-dlp.exe"));
        let info = engine.info();
        assert!(info.available);
        let problem = info.problem.expect("缺 ffmpeg 应产生结构化问题");
        assert_eq!(problem.code, "ffmpegMissing");
        assert_eq!(problem.remedy, Remedy::Reinstall);
        // 诊断会把该结构原样序列化，detail 必须是人话且不含路径。
        assert!(!problem.detail.contains(":\\"));
        assert!(!problem.detail.is_empty());
    }

    #[test]
    fn info_has_no_problem_when_engine_is_ready() {
        let engine = Engine::for_test_paths(
            PathBuf::from("yt-dlp.exe"),
            Some(PathBuf::from("ffmpeg.exe")),
        );
        assert!(engine.info().problem.is_none());
    }

    #[test]
    fn refresh_can_clear_a_problem() {
        // 缺 ffmpeg → 有 problem；替换成完整引擎后 problem 应消失。
        let engine = Engine::for_test(PathBuf::from("yt-dlp.exe"));
        assert!(engine.info().problem.is_some());
        *engine
            .inner
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = EngineInner {
            yt_dlp: Some(PathBuf::from("yt-dlp.exe")),
            ffmpeg: Some(PathBuf::from("ffmpeg.exe")),
            yt_dlp_version: Some("2026.01.01".into()),
            ffmpeg_version: Some("7.0".into()),
            integrity_message: None,
        };
        assert!(engine.info().problem.is_none());
        assert!(engine.ffmpeg_path().is_some());
    }

    #[test]
    fn maps_login_and_geo_failures() {
        let login = map_probe_failure("ERROR: This video requires login", Some(1));
        assert_eq!(login.code(), "auth_required");
        let geo = map_probe_failure("ERROR: Not available in your region", Some(1));
        assert_eq!(geo.code(), "geo_blocked");
    }

    #[test]
    fn maps_risk_control_before_other_causes() {
        let http = map_probe_failure("ERROR: HTTP Error 412: Precondition Failed", Some(1));
        assert_eq!(http.code(), "risk_control");
        // 给用户的必须是可操作文案，而不是原始 stderr。
        assert!(http.message().contains("访问频率校验"));
        assert!(!http.message().contains("Precondition"));

        assert_eq!(
            map_probe_failure(
                "ERROR: Unable to download JSON metadata: code=-352",
                Some(1)
            )
            .code(),
            "risk_control"
        );
        // 含 vip 字样但仍是被风控拦下时，风控优先，避免误导成"需要大会员"。
        assert_eq!(
            map_probe_failure("HTTP Error 412: Precondition Failed (premium api)", Some(1)).code(),
            "risk_control"
        );
        // 与风控无关的失败维持原分类。
        assert_eq!(
            map_probe_failure("ERROR: This video requires login", Some(1)).code(),
            "auth_required"
        );
    }

    #[test]
    fn parses_missing_formats_as_locked_tiers() {
        let missing = parse_missing_formats(
            "Format(s) 1080P 高码率, 4K 超清 are missing; you have to become a premium member to download them.",
        );
        assert!(missing
            .iter()
            .any(|(label, _, reason)| label == "4K" && reason.contains("大会员")));
        assert!(missing
            .iter()
            .any(|(label, _, reason)| label == "1080P+" && reason.contains("大会员")));
        let locked = parse_missing_formats("Format(s) 1080P 高清 are missing; login required");
        assert!(locked
            .iter()
            .any(|(label, _, reason)| label == "1080P" && reason.contains("登录")));
    }

    #[test]
    fn counts_and_filters_danmaku_types() {
        let xml = r#"<?xml version="1.0"?><i><d p="1,25,1,16777215,0,0,0,0">滚动</d><d p="5,25,1,16777215,0,0,0,0">顶部</d><d p="7,25,1,16777215,0,0,0,0">高级</d></i>"#;
        let counts = count_danmaku_types(xml);
        assert_eq!(counts.get("scroll"), Some(&1));
        assert_eq!(counts.get("top"), Some(&1));
        assert_eq!(counts.get("advanced"), Some(&1));
        let filtered = filter_danmaku_xml(xml, &["scroll".into(), "advanced".into()]);
        assert!(filtered.contains("滚动"));
        assert!(filtered.contains("高级"));
        assert!(!filtered.contains("顶部"));
        assert!(filtered.starts_with("<?xml"));
        assert!(filtered.ends_with("</i>"));
    }

    #[test]
    fn decodes_compressed_danmaku_bodies() {
        use flate2::write::{DeflateEncoder, GzEncoder, ZlibEncoder};
        use flate2::Compression;
        use std::io::Write;

        let xml = r#"<?xml version="1.0" encoding="UTF-8"?><i><d p="1,25,1,16777215,0,0,0,0">滚动</d></i>"#;
        let mut raw = DeflateEncoder::new(Vec::new(), Compression::default());
        raw.write_all(xml.as_bytes()).unwrap();
        let raw = raw.finish().unwrap();
        assert!(decode_danmaku_body(&raw, "deflate")
            .unwrap()
            .contains("滚动"));

        let mut zlib = ZlibEncoder::new(Vec::new(), Compression::default());
        zlib.write_all(xml.as_bytes()).unwrap();
        let zlib = zlib.finish().unwrap();
        assert!(decode_danmaku_body(&zlib, "deflate")
            .unwrap()
            .contains("滚动"));

        let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
        gzip.write_all(xml.as_bytes()).unwrap();
        let gzip = gzip.finish().unwrap();
        assert!(decode_danmaku_body(&gzip, "gzip").unwrap().contains("滚动"));

        assert!(decode_danmaku_body(xml.as_bytes(), "")
            .unwrap()
            .contains("滚动"));
        assert_eq!(
            decode_danmaku_body(b"<html><body>no</body></html>", "")
                .unwrap_err()
                .code(),
            "danmaku_decode"
        );
        assert_eq!(
            decode_danmaku_body(&[0xcc, 0xbd, 0xeb, 0x92], "")
                .unwrap_err()
                .code(),
            "danmaku_decode"
        );
    }

    #[test]
    fn verifies_sidecar_hashes() {
        let path = std::env::temp_dir().join(format!(
            "bilipocket-hash-{}-{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_file(&path);
        assert!(expected_hash("yt-dlp").is_some());
        assert!(verify_binary(Path::new("missing-file"), "yt-dlp").is_err());
    }

    #[test]
    fn probe_command_passes_cookie_as_header_without_subtitle_writes() {
        let engine = Engine::for_test(PathBuf::from("yt-dlp.exe"));
        let command = engine
            .probe_command("BV1xx411c7mD", Some("SESSDATA=abc"), None)
            .unwrap();
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args.contains(&"--add-header".to_string()));
        assert!(args.contains(&"Cookie: SESSDATA=abc".to_string()));
        assert!(!args.contains(&"--cookies".to_string()));
        assert!(!args.contains(&"--write-subs".to_string()));
        assert!(!args.contains(&"--write-auto-subs".to_string()));
    }

    #[test]
    #[ignore]
    fn probes_real_bilibili_video() {
        let path =
            std::env::var("BILIPOCKET_YTDLP").expect("BILIPOCKET_YTDLP must point to yt-dlp");
        let engine = Engine::for_test(PathBuf::from(path));
        let probe = engine
            .probe_with_cookies("https://www.bilibili.com/video/BV1xx411c7mD", None, None)
            .expect("real probe should succeed");
        assert!(!probe.title.trim().is_empty());
        assert!(!probe.qualities.is_empty());
        assert!(probe.danmaku.available);
        assert!(probe.danmaku.url.is_some());
        println!(
            "probe title={} qualities={:?} subtitles={} danmaku={}",
            probe.title,
            probe
                .qualities
                .iter()
                .map(|quality| quality.label.as_str())
                .collect::<Vec<_>>(),
            probe.subtitles.len(),
            probe.danmaku.available
        );
    }

    #[test]
    fn collects_language_tagged_audio_only_streams() {
        let value = serde_json::json!({
            "formats": [
                // 带语言的纯音频流，应入选
                {"format_id": "30280", "vcodec": "none", "acodec": "mp4a", "language": "zh-Hans", "format": "audio zh-Hans"},
                // 同 id 重复出现只保留一条
                {"format_id": "30280", "vcodec": "none", "acodec": "mp4a", "language": "zh-Hans", "format": "audio zh-Hans"},
                // 第二条语言轨，也应入选
                {"format_id": "30281", "vcodec": "none", "acodec": "mp4a", "language": "en", "format_note": "audio en"},
                // 视频流虽然带 language，但不是音轨，必须排除
                {"format_id": "30080", "vcodec": "avc1", "acodec": "mp4a", "language": "zh-Hans"},
                // 没有语言标签的普通音频，排除（否则 UI 会出现一堆无意义选项）
                {"format_id": "30216", "vcodec": "none", "acodec": "mp4a"},
                // language 为 none 等同于没有标签
                {"format_id": "30217", "vcodec": "none", "acodec": "mp4a", "language": "none"},
                // language 为空串同样排除
                {"format_id": "30218", "vcodec": "none", "acodec": "mp4a", "language": ""}
            ]
        });
        let tracks = parse_audio_tracks(&value);
        assert_eq!(tracks.len(), 2, "实际：{tracks:?}");
        assert_eq!(tracks[0].id, "30280");
        assert_eq!(tracks[0].language.as_deref(), Some("zh-Hans"));
        assert_eq!(tracks[0].label, "audio zh-Hans");
        assert_eq!(tracks[1].id, "30281");
        // 没有 format 字段时退回 format_note
        assert_eq!(tracks[1].label, "audio en");
    }

    #[test]
    fn missing_formats_yields_no_audio_tracks() {
        assert!(parse_audio_tracks(&serde_json::json!({})).is_empty());
        assert!(parse_audio_tracks(&serde_json::json!({"formats": []})).is_empty());
    }
}
