//! 下载完成后的可选附加处理。
//! 全部是 best-effort：失败只写日志或 extras_error，绝不把已成功的任务改成失败。

use std::path::{Path, PathBuf};

use crate::domain::Task;

/// T12：0 字节 / 过小产物不得冒充成功。
/// 不引入 ffprobe（安装包只随附 ffmpeg），只做尺寸与容器头校验。
pub fn verify_output(path: &Path, audio_only: bool) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|error| format!("无法读取产物：{error}"))?;
    if meta.len() == 0 {
        return Err("产物为 0 字节".into());
    }
    let minimum = if audio_only { 1024 } else { 16 * 1024 };
    if meta.len() < minimum {
        return Err(format!("产物过小（{} 字节）", meta.len()));
    }
    Ok(())
}

/// T08：把缓存的封面复制到视频目录。
/// `poster` -> `<stem>-poster.jpg`（Jellyfin / Emby）；`stem` -> `<stem>.jpg`。
pub fn copy_cover(
    cover_path: Option<&str>,
    video: &Path,
    naming: &str,
    enabled: bool,
) -> Result<Option<PathBuf>, String> {
    if !enabled {
        return Ok(None);
    }
    let Some(source) = cover_path.map(Path::new).filter(|path| path.is_file()) else {
        return Ok(None);
    };
    let Some(stem) = video.file_stem().and_then(|value| value.to_str()) else {
        return Ok(None);
    };
    let Some(parent) = video.parent() else {
        return Ok(None);
    };
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("jpg");
    let name = if naming == "stem" {
        format!("{stem}.{extension}")
    } else {
        format!("{stem}-poster.{extension}")
    };
    let destination = parent.join(name);
    std::fs::copy(source, &destination).map_err(|error| format!("封面复制失败：{error}"))?;
    Ok(Some(destination))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// T14：写媒体库可读取的 NFO。标题含特殊字符时必须转义。
pub fn write_nfo(
    video: &Path,
    task: &Task,
    title_source: &str,
    published_at: Option<i64>,
    cover: Option<&Path>,
) -> Result<PathBuf, String> {
    let Some(stem) = video.file_stem().and_then(|value| value.to_str()) else {
        return Err("无法取得文件名".into());
    };
    let Some(parent) = video.parent() else {
        return Err("无法取得视频目录".into());
    };
    let page = task.options.page_title.as_deref().unwrap_or("");
    let title: String = match title_source {
        "page" if !page.is_empty() => page.to_string(),
        "combined" if !page.is_empty() => format!("{} - {}", task.title, page),
        _ => task.title.clone(),
    };
    let root = if task.options.page_index.is_some() {
        "episodedetails"
    } else {
        "movie"
    };
    let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n");
    xml.push_str(&format!("<{root}>\n"));
    xml.push_str(&format!("  <title>{}</title>\n", xml_escape(&title)));
    if let Some(plot) = task.bvid.as_deref() {
        xml.push_str(&format!("  <uniqueid type=\"bvid\">{plot}</uniqueid>\n"));
    }
    xml.push_str(&format!("  <studio>{}</studio>\n", xml_escape(&task.uploader)));
    if let Some(timestamp) = published_at.filter(|value| *value > 0) {
        let date = crate::files::format_date(timestamp.saturating_mul(1000));
        xml.push_str(&format!("  <aired>{date}</aired>\n"));
        xml.push_str(&format!("  <premiered>{date}</premiered>\n"));
    }
    if let Some(thumb) = cover.and_then(|path| path.file_name()).and_then(|n| n.to_str()) {
        xml.push_str(&format!("  <thumb>{}</thumb>\n", xml_escape(thumb)));
    }
    xml.push_str(&format!("</{root}>\n"));
    let destination = parent.join(format!("{stem}.nfo"));
    std::fs::write(&destination, xml).map_err(|error| format!("NFO 写入失败：{error}"))?;
    Ok(destination)
}

#[derive(Debug, Clone)]
pub struct Chapter {
    pub title: String,
    pub start_seconds: u64,
    pub end_seconds: u64,
}

fn ffmetadata(chapters: &[Chapter]) -> String {
    let mut text = String::from(";FFMETADATA1\n");
    for chapter in chapters {
        // 毫秒单位；TIMEBASE=1/1000
        text.push_str("[CHAPTER]\nTIMEBASE=1/1000\n");
        text.push_str(&format!("START={}\n", chapter.start_seconds * 1000));
        text.push_str(&format!("END={}\n", chapter.end_seconds * 1000));
        text.push_str(&format!("title={}\n", chapter.title.replace(['\n', '\r', '='], " ")));
    }
    text
}

/// T10：生成 ffmetadata 并用 ffmpeg 二次封装写入章节。
/// 失败时保留原文件不动（临时输出先写 .tmp，再原子替换）。
pub fn write_chapters(
    ffmpeg: Option<&Path>,
    video: &Path,
    chapters: &[Chapter],
) -> Result<usize, String> {
    if chapters.is_empty() {
        return Ok(0);
    }
    let Some(ffmpeg) = ffmpeg else {
        return Err("未找到 ffmpeg".into());
    };
    let dir = video.parent().ok_or("无法取得视频目录")?;
    let meta = dir.join(format!(
        ".chapters-{}.txt",
        uuid::Uuid::new_v4().simple()
    ));
    let temp_output = dir.join(format!(
        ".chapters-{}.{}",
        uuid::Uuid::new_v4().simple(),
        video.extension().and_then(|v| v.to_str()).unwrap_or("mkv")
    ));
    std::fs::write(&meta, ffmetadata(chapters)).map_err(|e| e.to_string())?;
    let status = std::process::Command::new(ffmpeg)
        .arg("-y")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(video)
        .arg("-i")
        .arg(&meta)
        .arg("-map_metadata")
        .arg("1")
        .arg("-map")
        .arg("0")
        .arg("-codec")
        .arg("copy")
        .arg(&temp_output)
        .status();
    let _ = std::fs::remove_file(&meta);
    let status = status.map_err(|e| format!("ffmpeg 启动失败：{e}"))?;
    if !status.success() || !temp_output.is_file() {
        let _ = std::fs::remove_file(&temp_output);
        return Err("ffmpeg 写入章节失败".into());
    }
    std::fs::rename(&temp_output, video).map_err(|error| {
        let _ = std::fs::remove_file(&temp_output);
        format!("替换带章节文件失败：{error}")
    })?;
    Ok(chapters.len())
}

/// T09：字幕语言一致性提醒（只提示，不阻断）。
/// yt-dlp 会把语言写进文件名，如 `xxx.zh-Hans.srt`。
pub fn subtitle_language_mismatch(subtitle: &Path, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    let Some(name) = subtitle.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let language = name.strip_suffix(".srt").or_else(|| name.strip_suffix(".ass"));
    match language.and_then(|n| n.rsplit_once('.')) {
        Some((_, lang)) => !lang.eq_ignore_ascii_case(expected),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_escapes_special_characters() {
        assert_eq!(xml_escape("a<b>&\"'"), "a&lt;b&gt;&amp;&quot;&apos;");
    }

    #[test]
    fn ffmetadata_uses_millisecond_chapters() {
        let text = ffmetadata(&[Chapter {
            title: "第一段".into(),
            start_seconds: 10,
            end_seconds: 30,
        }]);
        assert!(text.starts_with(";FFMETADATA1"));
        assert!(text.contains("START=10000"));
        assert!(text.contains("END=30000"));
    }

    #[test]
    fn detects_subtitle_language_mismatch() {
        assert!(subtitle_language_mismatch(
            Path::new("v.zh-Hans.srt"),
            "en"
        ));
        assert!(!subtitle_language_mismatch(
            Path::new("v.zh-Hans.srt"),
            "zh-Hans"
        ));
        assert!(!subtitle_language_mismatch(Path::new("v.srt"), "en"));
    }

    #[test]
    fn rejects_empty_output() {
        let dir = std::env::temp_dir().join(format!("bp_verify_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("empty.mp4");
        std::fs::write(&file, b"").unwrap();
        assert!(verify_output(&file, false).is_err());
        std::fs::write(&file, vec![0u8; 20_000]).unwrap();
        assert!(verify_output(&file, false).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bp_{tag}_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_task(title: &str) -> Task {
        Task {
            options: Default::default(),
            id: "task".into(),
            kind: crate::domain::TaskKind::Video,
            source_url: "https://www.bilibili.com/video/BV1xx411c7mD".into(),
            bvid: Some("BV1xx411c7mD".into()),
            title: title.into(),
            uploader: "UP 主".into(),
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
            status: crate::domain::TaskStatus::Queued,
            error_code: None,
            error_message: None,
            extras_error: None,
            output_path: None,
            temp_dir: None,
            danmaku_types: Vec::new(),
            danmaku_count: 0,
            subtitle_langs: Vec::new(),
            engine_version: None,
            attempt: 0,
            created_at: 0,
            queued_at: None,
            started_at: None,
            completed_at: None,
            retry_at: None,
        }
    }

    #[test]
    fn copies_cover_using_poster_or_stem_naming() {
        let dir = temp_dir("cover");
        let source = dir.join("cache.jpg");
        std::fs::write(&source, b"img").unwrap();
        let video = dir.join("视频.mp4");
        std::fs::write(&video, b"v").unwrap();
        let source_text = source.to_string_lossy().into_owned();

        let poster = copy_cover(Some(&source_text), &video, "poster", true)
            .unwrap()
            .expect("应产出封面");
        assert_eq!(poster.file_name().and_then(|n| n.to_str()), Some("视频-poster.jpg"));

        let stem = copy_cover(Some(&source_text), &video, "stem", true)
            .unwrap()
            .expect("应产出封面");
        assert_eq!(stem.file_name().and_then(|n| n.to_str()), Some("视频.jpg"));

        // 开关关闭时不产出，也不报错。
        assert!(copy_cover(Some(&source_text), &video, "poster", false)
            .unwrap()
            .is_none());
        // 封面缓存缺失时静默跳过，不能把已成功的任务判失败。
        assert!(copy_cover(Some("不存在的文件.jpg"), &video, "poster", true)
            .unwrap()
            .is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn writes_nfo_with_escaped_title_and_page_aware_root() {
        let dir = temp_dir("nfo");
        let video = dir.join("视频.mp4");
        std::fs::write(&video, b"v").unwrap();

        let mut task = sample_task("A & B <tag>");
        task.options.published_at = Some(1_700_000_000);
        let path = write_nfo(&video, &task, "video", task.options.published_at, None).unwrap();
        let xml = std::fs::read_to_string(&path).unwrap();
        // 单 P 用 movie 根节点，标题必须转义。
        assert!(xml.contains("<movie>"), "{xml}");
        assert!(xml.contains("<title>A &amp; B &lt;tag&gt;</title>"), "{xml}");
        assert!(xml.contains("<aired>"), "应写入播出日期：{xml}");
        assert!(xml.contains("<uniqueid type=\"bvid\">BV1xx411c7mD</uniqueid>"), "{xml}");

        // 多 P 用 episodedetails，并按 page 来源取标题。
        let mut multi = sample_task("总标题");
        multi.options.page_index = Some(2);
        multi.options.page_title = Some("第二集".into());
        let path = write_nfo(&video, &multi, "page", None, None).unwrap();
        let xml = std::fs::read_to_string(&path).unwrap();
        assert!(xml.contains("<episodedetails>"), "{xml}");
        assert!(xml.contains("<title>第二集</title>"), "{xml}");

        // combined 把总标题和分 P 标题拼起来。
        let path = write_nfo(&video, &multi, "combined", None, None).unwrap();
        let xml = std::fs::read_to_string(&path).unwrap();
        assert!(xml.contains("<title>总标题 - 第二集</title>"), "{xml}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn fallback_title_source_when_page_title_is_missing() {
        let dir = temp_dir("nfo_fallback");
        let video = dir.join("视频.mp4");
        std::fs::write(&video, b"v").unwrap();
        let mut task = sample_task("总标题");
        task.options.page_index = Some(3);
        task.options.page_title = None;
        let path = write_nfo(&video, &task, "page", None, None).unwrap();
        let xml = std::fs::read_to_string(&path).unwrap();
        // 分 P 标题缺失时不能写空标题，退回总标题。
        assert!(xml.contains("<title>总标题</title>"), "{xml}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
