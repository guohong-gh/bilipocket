use std::path::{Path, PathBuf};

const MAX_BASE_CHARS: usize = 120;
const MEDIA_EXTENSIONS: &[&str] = &["mp4", "mkv", "m4a", "mp3", "webm", "flv"];
const RESERVED_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

pub fn sanitize_filename_base(value: &str) -> String {
    let mut cleaned = value
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            character if character.is_control() => ' ',
            character => character,
        })
        .collect::<String>();
    cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    cleaned = cleaned.trim_end_matches(['.', ' ']).trim().to_string();
    if cleaned.is_empty() {
        cleaned = "未命名视频".into();
    }
    if cleaned.chars().count() > MAX_BASE_CHARS {
        cleaned = cleaned.chars().take(MAX_BASE_CHARS).collect::<String>();
        cleaned = cleaned.trim_end_matches(['.', ' ']).to_string();
    }
    let stem = cleaned
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        cleaned = format!("_{cleaned}");
    }
    cleaned
}

pub fn format_date(timestamp_ms: i64) -> String {
    let seconds = timestamp_ms.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let _ = seconds_of_day;
    format!("{year:04}-{month:02}-{day:02}")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    (year, month as u32, day as u32)
}

#[derive(Debug, Default)]
pub struct FileCleanup {
    pub main_deleted: bool,
    pub removed: u32,
    pub errors: Vec<String>,
}

pub fn remove_download_files(
    output_path: &str,
    subtitle_langs: &[String],
    has_danmaku: bool,
    cover_naming: Option<&str>,
) -> Result<FileCleanup, String> {
    let output_path = output_path.trim();
    if output_path.is_empty() {
        return Err("下载文件路径为空。".into());
    }
    let path = Path::new(output_path);
    let mut cleanup = FileCleanup::default();

    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => {
            return Err("下载文件路径是目录，拒绝删除。".into());
        }
        Ok(_) => {
            cleanup.main_deleted = remove_file_with_retry(path)?;
            if cleanup.main_deleted {
                cleanup.removed += 1;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("无法读取下载文件：{error}")),
    }

    let (Some(parent), Some(stem)) = (
        path.parent(),
        path.file_stem().and_then(|value| value.to_str()),
    ) else {
        return Ok(cleanup);
    };

    for language in subtitle_langs {
        if !valid_sidecar_token(language) {
            cleanup
                .errors
                .push(format!("字幕语言名不合法，已跳过：{language}"));
            continue;
        }
        // T09：字幕格式可切换，三种扩展名都要清，否则切换格式后会留残骸。
        for extension in ["srt", "ass", "vtt"] {
            let sidecar = parent.join(format!("{stem}.{language}.{extension}"));
            match remove_file_with_retry(&sidecar) {
                Ok(true) => cleanup.removed += 1,
                Ok(false) => {}
                Err(error) => cleanup.errors.push(format!("字幕 {language}：{error}")),
            }
        }
    }

    if has_danmaku {
        let sidecar = parent.join(format!("{stem}.danmaku.xml"));
        match remove_file_with_retry(&sidecar) {
            Ok(true) => cleanup.removed += 1,
            Ok(false) => {}
            Err(error) => cleanup.errors.push(format!("弹幕：{error}")),
        }
    }

    // T08/T14：`-poster.*` 与 `.nfo` 只可能由本应用生成，无条件清理。
    for name in cover_candidates(stem, true) {
        match remove_file_with_retry(&parent.join(name)) {
            Ok(true) => cleanup.removed += 1,
            Ok(false) => {}
            Err(error) => cleanup.errors.push(format!("封面：{error}")),
        }
    }
    match remove_file_with_retry(&parent.join(format!("{stem}.nfo"))) {
        Ok(true) => cleanup.removed += 1,
        Ok(false) => {}
        Err(error) => cleanup.errors.push(format!("NFO：{error}")),
    }
    // 与视频同名的图片存在歧义（用户可能自己放了张图），
    // 只有当前命名偏好确实是 `stem` 时才清，宁可留残骸也不误删。
    if cover_naming == Some("stem") {
        for name in cover_candidates(stem, false) {
            match remove_file_with_retry(&parent.join(name)) {
                Ok(true) => cleanup.removed += 1,
                Ok(false) => {}
                Err(error) => cleanup.errors.push(format!("封面：{error}")),
            }
        }
    }

    Ok(cleanup)
}

/// 封面候选文件名。`poster` 形式无歧义；`stem` 形式与视频同名，需调用方自行判断。
fn cover_candidates(stem: &str, poster_style: bool) -> Vec<String> {
    const IMAGE_EXTENSIONS: [&str; 3] = ["jpg", "webp", "png"];
    IMAGE_EXTENSIONS
        .iter()
        .map(|extension| {
            if poster_style {
                format!("{stem}-poster.{extension}")
            } else {
                format!("{stem}.{extension}")
            }
        })
        .collect()
}

/// 校验拼进 sidecar 文件名的那一段（字幕语言、弹幕类型等）。
///
/// 注意：这是**安全边界**，不是格式校验。`remove_download_files` 会用它拼路径并删除文件，
/// 所以这里挡的是路径穿越（`/`、`\`、`..`）与盘符/ADS 写法（`:`）。
/// 想放宽格式（例如允许更多字符）之前，先确认删除路径仍然逃不出下载目录。
pub(crate) fn valid_sidecar_token(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('/')
        && !value.contains('\\')
        && !value.contains("..")
        && !value.contains(':')
}

fn remove_file_with_retry(path: &Path) -> Result<bool, String> {
    for attempt in 0..10 {
        match std::fs::remove_file(path) {
            Ok(()) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) if attempt < 9 => {
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(error) => return Err(format!("{error}")),
        }
    }
    Ok(false)
}

pub fn remove_partial_dir(
    data_dir: &Path,
    task_id: &str,
    stored_temp_dir: Option<&str>,
) -> Result<bool, String> {
    if task_id.is_empty()
        || task_id.len() > 64
        || !task_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("任务 ID 不合法，拒绝删除临时文件。".into());
    }

    let parts_dir = data_dir.join("parts");
    let expected = parts_dir.join(task_id);
    if let Some(stored) = stored_temp_dir {
        if normalize_path(&expected) != normalize_path(Path::new(stored)) {
            return Err("临时目录与任务记录不一致，拒绝删除。".into());
        }
    }

    let metadata = match std::fs::symlink_metadata(&expected) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("无法读取临时目录：{error}")),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("临时路径不是普通目录，拒绝删除。".into());
    }

    let canonical_parts = parts_dir
        .canonicalize()
        .map_err(|error| format!("无法校验临时目录：{error}"))?;
    let canonical_expected = expected
        .canonicalize()
        .map_err(|error| format!("无法校验临时目录：{error}"))?;
    if canonical_expected.parent() != Some(canonical_parts.as_path()) {
        return Err("临时目录不在任务目录下，拒绝删除。".into());
    }

    for _ in 0..10 {
        match std::fs::remove_dir_all(&expected) {
            Ok(()) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(200)),
        }
    }
    Err("临时文件正在被占用，暂时无法删除。".into())
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

/// Windows MAX_PATH 约 260；预留扩展名、后缀与余量，对基名做截断。
const MAX_PATH_CHARS: usize = 250;

pub fn build_output_path_with(
    download_dir: &Path,
    template: &str,
    vars: &TemplateVars<'_>,
    container: &str,
) -> Result<PathBuf, String> {
    let folder = build_video_folder(download_dir, vars.title)?;
    let mut base = render_template(template, vars);
    let extension = match container.to_ascii_lowercase().as_str() {
        "mp3" => "mp3",
        "mkv" => "mkv",
        "m4a" => "m4a",
        _ => "mp4",
    };
    let prefix_len = folder.as_os_str().to_string_lossy().chars().count() + extension.len() + 8;
    if prefix_len + base.chars().count() > MAX_PATH_CHARS {
        let keep = MAX_PATH_CHARS.saturating_sub(prefix_len).max(8);
        base = sanitize_filename_base(&base.chars().take(keep).collect::<String>());
        log::warn!("输出路径过长，已截断文件名基名至 {keep} 字符");
    }
    unique_path(&folder, &base, extension)
}

pub fn build_video_folder(download_dir: &Path, title: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(download_dir).map_err(|error| format!("无法创建下载目录：{error}"))?;
    let folder = download_dir.join(sanitize_filename_base(title));
    std::fs::create_dir_all(&folder).map_err(|error| format!("无法创建视频文件夹：{error}"))?;
    let root = download_dir
        .canonicalize()
        .map_err(|error| format!("无法校验下载目录：{error}"))?;
    let target = folder
        .canonicalize()
        .map_err(|error| format!("无法校验视频文件夹：{error}"))?;
    if target == root || !target.starts_with(&root) {
        return Err("视频文件夹不在下载目录下，已拒绝。".into());
    }
    Ok(folder)
}

/// 模板变量。新增变量只需往这里加，DB 与调用点不用跟着改。
#[derive(Debug, Clone, Default)]
pub struct TemplateVars<'a> {
    pub title: &'a str,
    pub quality_label: &'a str,
    pub uploader: &'a str,
    pub bvid: &'a str,
    pub completed_at_ms: i64,
    pub published_at_ms: Option<i64>,
    pub page_index: Option<u32>,
    pub page_title: Option<&'a str>,
}

/// 支持 `{date}` / `{date:%Y%m%d}` / `{pubdate}` / `{p}` / `{p_title}`。
/// 未知格式符（如 `%Q`）不 panic，原样保留并由文件名清洗处理。
pub fn render_template(template: &str, vars: &TemplateVars<'_>) -> String {
    let mut result = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        let Some(end_offset) = rest[start + 1..].find('}') else {
            break;
        };
        let end = start + 1 + end_offset;
        result.push_str(&rest[..start]);
        let token = &rest[start + 1..end];
        result.push_str(&expand_token(token, vars));
        rest = &rest[end + 1..];
    }
    result.push_str(rest);
    sanitize_filename_base(&result)
}

fn expand_token(token: &str, vars: &TemplateVars<'_>) -> String {
    let (name, format) = match token.split_once(':') {
        Some((name, format)) => (name, Some(format)),
        None => (token, None),
    };
    match name {
        "title" => vars.title.to_string(),
        "up" => vars.uploader.to_string(),
        "quality" => vars.quality_label.to_string(),
        "bvid" => vars.bvid.to_string(),
        "date" => format_timestamp(vars.completed_at_ms, format.unwrap_or("%Y-%m-%d")),
        "pubdate" => match vars.published_at_ms {
            Some(value) => format_timestamp(value, format.unwrap_or("%Y-%m-%d")),
            None => format_timestamp(vars.completed_at_ms, format.unwrap_or("%Y-%m-%d")),
        },
        "p" => vars
            .page_index
            .map(|index| index.to_string())
            .unwrap_or_default(),
        "p_title" => vars.page_title.unwrap_or_default().to_string(),
        _ => format!("{{{token}}}"),
    }
}

fn format_timestamp(timestamp_ms: i64, format: &str) -> String {
    let seconds = timestamp_ms.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3600;
    let minute = (seconds_of_day % 3600) / 60;
    let second = seconds_of_day % 60;
    let mut out = String::with_capacity(format.len() * 2);
    let mut chars = format.chars();
    while let Some(character) = chars.next() {
        if character != '%' {
            out.push(character);
            continue;
        }
        match chars.next() {
            Some('Y') => out.push_str(&format!("{year:04}")),
            Some('m') => out.push_str(&format!("{month:02}")),
            Some('d') => out.push_str(&format!("{day:02}")),
            Some('H') => out.push_str(&format!("{hour:02}")),
            Some('M') => out.push_str(&format!("{minute:02}")),
            Some('S') => out.push_str(&format!("{second:02}")),
            Some(other) => {
                out.push('%');
                out.push(other);
            }
            None => out.push('%'),
        }
    }
    out
}

pub fn template_base(
    template: &str,
    title: &str,
    quality_label: &str,
    uploader: &str,
    bvid: &str,
    completed_at_ms: i64,
) -> String {
    render_template(
        template,
        &TemplateVars {
            title,
            quality_label,
            uploader,
            bvid,
            completed_at_ms,
            ..Default::default()
        },
    )
}

fn unique_path(dir: &Path, base: &str, extension: &str) -> Result<PathBuf, String> {
    let mut candidate = dir.join(format!("{base}.{extension}"));
    let mut index = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{base} ({index}).{extension}"));
        index += 1;
        if index > 999 {
            return Err("同名文件过多，无法生成唯一文件名。".into());
        }
    }
    Ok(candidate)
}

pub fn resolve_extras_stem(folder: &Path, base: &str) -> String {
    for extension in MEDIA_EXTENSIONS {
        if folder.join(format!("{base}.{extension}")).is_file() {
            return base.to_string();
        }
    }

    let mut newest: Option<(std::time::SystemTime, String)> = None;
    if let Ok(entries) = std::fs::read_dir(folder) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
                continue;
            };
            let extension = extension.to_ascii_lowercase();
            if !MEDIA_EXTENSIONS.contains(&extension.as_str()) {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if !valid_sidecar_token(stem) {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            if newest
                .as_ref()
                .map(|(time, _)| modified >= *time)
                .unwrap_or(true)
            {
                newest = Some((modified, stem.to_string()));
            }
        }
    }
    newest
        .map(|(_, stem)| stem)
        .unwrap_or_else(|| base.to_string())
}

pub fn remove_extras_folder(
    folder: &str,
    subtitle_langs: &[String],
    has_danmaku: bool,
    download_root: &Path,
) -> Result<FileCleanup, String> {
    let folder = folder.trim();
    if folder.is_empty() {
        return Err("附加内容文件夹路径为空。".into());
    }
    let path = Path::new(folder);
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileCleanup::default());
        }
        Err(error) => return Err(format!("无法读取附加内容文件夹：{error}")),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("附加内容路径不是普通文件夹，拒绝删除。".into());
    }
    let root = download_root
        .canonicalize()
        .map_err(|error| format!("无法校验下载目录：{error}"))?;
    let target = path
        .canonicalize()
        .map_err(|error| format!("无法校验附加内容文件夹：{error}"))?;
    if target == root || !target.starts_with(&root) {
        return Err("附加内容文件夹不在下载目录下，拒绝删除。".into());
    }

    let mut cleanup = FileCleanup::default();
    for language in subtitle_langs {
        if !valid_sidecar_token(language) {
            cleanup
                .errors
                .push(format!("字幕语言名不合法，已跳过：{language}"));
        }
    }
    let entries =
        std::fs::read_dir(path).map_err(|error| format!("无法读取附加内容文件夹：{error}"))?;
    for entry in entries.filter_map(Result::ok) {
        let file_path = entry.path();
        let name = file_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let is_subtitle = subtitle_langs.iter().any(|language| {
            valid_sidecar_token(language) && name.ends_with(&format!(".{language}.srt"))
        });
        let is_danmaku = has_danmaku && name.ends_with(".danmaku.xml");
        if !is_subtitle && !is_danmaku {
            continue;
        }
        match remove_file_with_retry(&file_path) {
            Ok(true) => cleanup.removed += 1,
            Ok(false) => {}
            Err(error) => cleanup.errors.push(format!("{name}：{error}")),
        }
    }

    let empty = std::fs::read_dir(path)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false);
    if empty {
        match std::fs::remove_dir(path) {
            Ok(()) => cleanup.main_deleted = true,
            Err(error) => cleanup.errors.push(format!("无法删除空文件夹：{error}")),
        }
    }
    Ok(cleanup)
}

#[derive(Debug, PartialEq, Eq)]
pub enum WriteProbeError {
    /// 目录不可写（权限/只读盘）。
    PermissionDenied,
    /// 路径过长，Windows 上会因为 MAX_PATH 直接失败。
    PathTooLong,
    /// 目录不存在且无法创建（例如离线移动硬盘）。
    Unavailable,
    /// 其他 IO 失败，携带原因但不含路径。
    Io(String),
}

impl WriteProbeError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::PermissionDenied => "dir_not_writable",
            Self::PathTooLong => "path_too_long",
            Self::Unavailable => "dir_unavailable",
            Self::Io(_) => "dir_probe_failed",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::PermissionDenied => "下载目录不可写入，请换一个目录或检查权限。".into(),
            Self::PathTooLong => "下载目录路径过长，请换一个更短的路径。".into(),
            Self::Unavailable => "下载目录所在位置当前不可用。".into(),
            Self::Io(reason) => format!("无法在下载目录写入文件：{reason}"),
        }
    }
}

/// 真正写一个临时文件再删掉。
/// 不用只读属性或 `access()` 判断——网络盘、漫游目录、只读缓存都会给出错误结论。
pub fn probe_writable(dir: &Path) -> Result<(), WriteProbeError> {
    if dir.as_os_str().len() > 250 {
        return Err(WriteProbeError::PathTooLong);
    }
    if let Err(error) = std::fs::create_dir_all(dir) {
        return Err(match error.kind() {
            std::io::ErrorKind::PermissionDenied => WriteProbeError::PermissionDenied,
            std::io::ErrorKind::NotFound => WriteProbeError::Unavailable,
            _ => WriteProbeError::Io(error.to_string()),
        });
    }
    let probe = dir.join(format!(
        ".bilipocket-write-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0)
    ));
    match std::fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(error) => {
            let _ = std::fs::remove_file(&probe);
            Err(match error.kind() {
                std::io::ErrorKind::PermissionDenied => WriteProbeError::PermissionDenied,
                std::io::ErrorKind::NotFound => WriteProbeError::Unavailable,
                _ => WriteProbeError::Io(error.to_string()),
            })
        }
    }
}

pub fn prune_empty_download_dir(parent: &Path, download_root: &Path) -> Result<bool, String> {
    let metadata = match std::fs::symlink_metadata(parent) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("无法读取视频文件夹：{error}")),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(false);
    }
    let root = download_root
        .canonicalize()
        .map_err(|error| format!("无法校验下载目录：{error}"))?;
    let target = parent
        .canonicalize()
        .map_err(|error| format!("无法校验视频文件夹：{error}"))?;
    if target == root || !target.starts_with(&root) {
        return Ok(false);
    }
    let mut entries =
        std::fs::read_dir(parent).map_err(|error| format!("无法读取视频文件夹：{error}"))?;
    if entries.next().is_some() {
        return Ok(false);
    }
    drop(entries);
    std::fs::remove_dir(parent).map_err(|error| format!("无法删除空文件夹：{error}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_writable_creates_and_removes_file() {
        let dir = std::env::temp_dir().join(format!("bilipocket-probe-{}", uuid::Uuid::new_v4()));
        assert_eq!(probe_writable(&dir), Ok(()));
        // 探针不能留下任何文件。
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .count();
        assert_eq!(leftovers, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_writable_flags_too_long_path() {
        let dir = std::env::temp_dir().join("a".repeat(260));
        assert_eq!(probe_writable(&dir), Err(WriteProbeError::PathTooLong));
        assert_eq!(WriteProbeError::PathTooLong.code(), "path_too_long");
    }

    #[test]
    fn write_probe_errors_have_stable_codes() {
        assert_eq!(WriteProbeError::PermissionDenied.code(), "dir_not_writable");
        assert_eq!(WriteProbeError::Unavailable.code(), "dir_unavailable");
        // 消息里不能出现路径。
        assert!(!WriteProbeError::Io("拒绝访问".into())
            .message()
            .contains(":\\"));
    }

    #[test]
    fn sanitizes_windows_invalid_names() {
        assert_eq!(sanitize_filename_base(" a/b:c*? "), "a_b_c__");
        assert_eq!(sanitize_filename_base("CON"), "_CON");
        assert_eq!(sanitize_filename_base("name. "), "name");
        assert_eq!(sanitize_filename_base(""), "未命名视频");
    }

    #[test]
    fn formats_epoch_dates() {
        assert_eq!(format_date(0), "1970-01-01");
        assert_eq!(format_date(1_700_000_000_000), "2023-11-14");
    }

    #[test]
    fn expands_date_formats_and_new_variables() {
        let vars = TemplateVars {
            title: "示例",
            quality_label: "1080P",
            uploader: "UP",
            bvid: "BV1",
            completed_at_ms: 1_700_000_000_000,
            published_at_ms: Some(1_600_000_000_000),
            page_index: Some(3),
            page_title: Some("第三集"),
        };
        assert_eq!(render_template("{date}", &vars), "2023-11-14");
        assert_eq!(render_template("{date:%Y%m%d}", &vars), "20231114");
        assert_eq!(
            render_template("{date:%Y-%m-%d_%H%M}", &vars),
            "2023-11-14_2213"
        );
        assert_eq!(render_template("{pubdate:%Y%m%d}", &vars), "20200913");
        assert_eq!(render_template("{p}_{p_title}", &vars), "3_第三集");
        // 未知格式符原样保留，不 panic。
        assert_eq!(render_template("{date:%Q}", &vars), "%Q");
    }

    #[test]
    fn unknown_template_variables_are_kept() {
        let vars = TemplateVars::default();
        assert_eq!(render_template("{unknown}", &vars), "{unknown}");
        // 模板只有 {title} 且标题为空时，仍有「未命名视频」兜底。
        assert_eq!(render_template("{title}", &vars), "未命名视频");
    }

    #[test]
    fn long_output_path_is_truncated() {
        let directory =
            std::env::temp_dir().join(format!("bilipocket_long_{}", uuid::Uuid::new_v4()));
        let vars = TemplateVars {
            title: "长标题",
            ..Default::default()
        };
        let template = format!("{{title}}_{}", "x".repeat(300));
        let path = build_output_path_with(&directory, &template, &vars, "mp4").unwrap();
        assert!(path.as_os_str().to_string_lossy().chars().count() < 260);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn builds_template_path_and_avoids_collisions() {
        let directory =
            std::env::temp_dir().join(format!("bilipocket_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let vars = TemplateVars {
            title: "测试/视频",
            quality_label: "1080P",
            uploader: "UP",
            bvid: "BV123",
            completed_at_ms: 0,
            ..Default::default()
        };
        let first =
            build_output_path_with(&directory, "{title} [{quality}]", &vars, "mp4").unwrap();
        assert_eq!(
            first.file_name().unwrap().to_string_lossy(),
            "测试_视频 [1080P].mp4"
        );
        assert_eq!(
            first
                .parent()
                .unwrap()
                .file_name()
                .unwrap()
                .to_string_lossy(),
            "测试_视频"
        );
        std::fs::write(&first, b"x").unwrap();
        let second =
            build_output_path_with(&directory, "{title} [{quality}]", &vars, "mp4").unwrap();
        assert_eq!(
            second.file_name().unwrap().to_string_lossy(),
            "测试_视频 [1080P] (2).mp4"
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn resolves_extras_stem_from_the_existing_video() {
        let directory =
            std::env::temp_dir().join(format!("bilipocket_stem_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let folder = build_video_folder(&directory, "测试视频").unwrap();
        std::fs::write(folder.join("测试视频 [1080P].mp4"), b"video").unwrap();
        assert_eq!(
            resolve_extras_stem(&folder, "测试视频 [1080P]"),
            "测试视频 [1080P]"
        );
        assert_eq!(
            resolve_extras_stem(&folder, "测试视频 [720P]"),
            "测试视频 [1080P]"
        );
        let empty = folder.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(resolve_extras_stem(&empty, "测试视频"), "测试视频");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn removes_extras_but_keeps_the_video() {
        let directory =
            std::env::temp_dir().join(format!("bilipocket_extras_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let folder = build_video_folder(&directory, "测试视频").unwrap();
        let video = folder.join("测试视频.mp4");
        let subtitle = folder.join("测试视频.zh-Hans.srt");
        let danmaku = folder.join("测试视频.danmaku.xml");
        let other = folder.join("测试视频.en.srt");
        std::fs::write(&video, b"video").unwrap();
        std::fs::write(&subtitle, b"subtitle").unwrap();
        std::fs::write(&danmaku, b"danmaku").unwrap();
        std::fs::write(&other, b"other").unwrap();

        let cleanup = remove_extras_folder(
            &folder.to_string_lossy(),
            &["zh-Hans".into()],
            true,
            &directory,
        )
        .unwrap();
        assert_eq!(cleanup.removed, 2);
        assert!(cleanup.errors.is_empty());
        assert!(video.exists());
        assert!(!subtitle.exists());
        assert!(!danmaku.exists());
        assert!(other.exists());
        assert!(folder.exists());

        std::fs::remove_file(&video).unwrap();
        std::fs::remove_file(&other).unwrap();
        let cleanup = remove_extras_folder(
            &folder.to_string_lossy(),
            &["zh-Hans".into()],
            true,
            &directory,
        )
        .unwrap();
        assert!(cleanup.main_deleted);
        assert!(!folder.exists());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn refuses_to_delete_outside_the_download_root() {
        let root = std::env::temp_dir().join(format!("bilipocket_root_{}", uuid::Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("bilipocket_outside_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("video.danmaku.xml"), b"x").unwrap();

        assert!(remove_extras_folder(&outside.to_string_lossy(), &[], true, &root).is_err());
        assert!(remove_extras_folder(&root.to_string_lossy(), &[], true, &root).is_err());
        assert!(outside.join("video.danmaku.xml").exists());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn prunes_only_empty_child_directories() {
        let root = std::env::temp_dir().join(format!("bilipocket_prune_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let empty = root.join("empty");
        let busy = root.join("busy");
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::create_dir_all(&busy).unwrap();
        std::fs::write(busy.join("video.mp4"), b"x").unwrap();

        assert!(!prune_empty_download_dir(&root, &root).unwrap());
        assert!(prune_empty_download_dir(&empty, &root).unwrap());
        assert!(!empty.exists());
        assert!(!prune_empty_download_dir(&busy, &root).unwrap());
        assert!(busy.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn removes_download_file_and_sidecars() {
        let directory =
            std::env::temp_dir().join(format!("bilipocket_cleanup_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let video = directory.join("video.mp4");
        let subtitle = directory.join("video.zh-Hans.srt");
        let danmaku = directory.join("video.danmaku.xml");
        std::fs::write(&video, b"video").unwrap();
        std::fs::write(&subtitle, b"subtitle").unwrap();
        std::fs::write(&danmaku, b"danmaku").unwrap();

        let cleanup = remove_download_files(
            &video.to_string_lossy(),
            &["zh-Hans".to_string()],
            true,
            None,
        )
        .unwrap();
        assert!(cleanup.main_deleted);
        assert_eq!(cleanup.removed, 3);
        assert!(cleanup.errors.is_empty());
        assert!(!video.exists());
        assert!(!subtitle.exists());
        assert!(!danmaku.exists());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn cleans_sidecars_when_main_file_is_missing_and_rejects_unsafe_names() {
        let directory =
            std::env::temp_dir().join(format!("bilipocket_cleanup_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let video = directory.join("video.mp4");
        let subtitle = directory.join("video.zh-Hans.srt");
        let danmaku = directory.join("video.danmaku.xml");
        let victim = directory.join("victim.srt");
        std::fs::write(&subtitle, b"subtitle").unwrap();
        std::fs::write(&danmaku, b"danmaku").unwrap();
        std::fs::write(&victim, b"keep").unwrap();

        let cleanup = remove_download_files(
            &video.to_string_lossy(),
            &["../victim".to_string()],
            true,
            None,
        )
        .unwrap();
        assert!(!cleanup.main_deleted);
        assert_eq!(cleanup.removed, 1);
        assert_eq!(cleanup.errors.len(), 1);
        assert!(!danmaku.exists());
        assert!(victim.exists());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn rejects_directory_as_download_file() {
        let directory =
            std::env::temp_dir().join(format!("bilipocket_cleanup_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        assert!(remove_download_files(&directory.to_string_lossy(), &[], false, None).is_err());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn removes_cover_nfo_and_every_subtitle_extension() {
        let directory =
            std::env::temp_dir().join(format!("bilipocket_cleanup_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let video = directory.join("video.mp4");
        let poster = directory.join("video-poster.jpg");
        let stem_cover = directory.join("video.webp");
        let nfo = directory.join("video.nfo");
        let ass = directory.join("video.zh-Hans.ass");
        let unrelated = directory.join("notes.txt");
        for path in [&video, &poster, &stem_cover, &nfo, &ass, &unrelated] {
            std::fs::write(path, b"x").unwrap();
        }

        let cleanup = remove_download_files(
            &video.to_string_lossy(),
            &["zh-Hans".to_string()],
            false,
            Some("stem"),
        )
        .unwrap();
        // video + poster + stem 封面 + nfo + ass
        assert_eq!(cleanup.removed, 5);
        assert!(cleanup.errors.is_empty());
        for path in [&video, &poster, &stem_cover, &nfo, &ass] {
            assert!(!path.exists(), "{} 应被删除", path.display());
        }
        assert!(unrelated.exists(), "无关文件不能被误删");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn keeps_stem_named_image_when_poster_naming_is_selected() {
        let directory =
            std::env::temp_dir().join(format!("bilipocket_cleanup_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let video = directory.join("video.mp4");
        let poster = directory.join("video-poster.jpg");
        let user_image = directory.join("video.jpg");
        for path in [&video, &poster, &user_image] {
            std::fs::write(path, b"x").unwrap();
        }

        let cleanup =
            remove_download_files(&video.to_string_lossy(), &[], false, Some("poster")).unwrap();
        assert_eq!(cleanup.removed, 2);
        assert!(!poster.exists());
        // 命名偏好是 poster 时，与视频同名的图片可能属于用户，不能删。
        assert!(user_image.exists());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn removes_only_the_validated_task_partial_directory() {
        let data_dir =
            std::env::temp_dir().join(format!("bilipocket_parts_{}", uuid::Uuid::new_v4()));
        let part = data_dir.join("parts").join("task-1");
        std::fs::create_dir_all(&part).unwrap();
        std::fs::write(part.join("video.part"), b"partial").unwrap();
        let stored = part.to_string_lossy().into_owned();

        assert!(remove_partial_dir(&data_dir, "task-1", Some(&stored)).unwrap());
        assert!(!part.exists());
        assert!(!remove_partial_dir(&data_dir, "task-1", Some(&stored)).unwrap());
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[test]
    fn rejects_invalid_or_mismatched_partial_paths() {
        let data_dir =
            std::env::temp_dir().join(format!("bilipocket_parts_{}", uuid::Uuid::new_v4()));
        let part = data_dir.join("parts").join("task-1");
        std::fs::create_dir_all(&part).unwrap();

        assert!(remove_partial_dir(&data_dir, "../task-1", None).is_err());
        assert!(remove_partial_dir(&data_dir, "task-1", Some("C:\\Windows")).is_err());
        std::fs::write(data_dir.join("parts").join("file"), b"x").unwrap();
        assert!(remove_partial_dir(&data_dir, "file", None).is_err());
        assert!(part.exists());
        let _ = std::fs::remove_dir_all(data_dir);
    }
}
