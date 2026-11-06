use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use serde_json::json;

use crate::domain::{now_ms, AuthStatus, EngineInfo, Settings, Task, TaskStatus};

const MAX_LOG_TAIL_BYTES: u64 = 512 * 1024;
const MAX_LOG_LINES: usize = 200;

const SENSITIVE_KEYS: [&str; 12] = [
    "SESSDATA",
    "bili_jct",
    "DedeUserID",
    "DedeUserID__ckMd5",
    "buvid3",
    "buvid4",
    "ac_time_value",
    "qrcode_key",
    "access_token",
    "refresh_token",
    "cookie",
    "authorization",
];

fn truncate_value(line: &str, key: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let key_lower = key.to_ascii_lowercase();
    let mut result = String::with_capacity(line.len());
    let mut cursor = 0usize;
    while let Some(relative) = lower[cursor..].find(&key_lower) {
        let start = cursor + relative;
        let after_key = start + key.len();
        result.push_str(&line[cursor..after_key]);
        let mut value_start = after_key;
        let bytes = line.as_bytes();
        while value_start < line.len()
            && matches!(
                bytes[value_start],
                b' ' | b'\t' | b'=' | b':' | b'"' | b'\''
            )
        {
            value_start += 1;
        }
        let mut end = value_start;
        while end < line.len() {
            let ch = line[end..].chars().next().unwrap_or_default();
            if ch.is_whitespace() || matches!(ch, ';' | '&' | ',' | '"' | '\'') {
                break;
            }
            end += ch.len_utf8();
        }
        if end > value_start {
            result.push_str("<redacted>");
        }
        cursor = end;
        if cursor >= line.len() {
            break;
        }
    }
    if cursor < line.len() {
        result.push_str(&line[cursor..]);
    }
    result
}

fn redact_url_queries(line: &str) -> String {
    let mut result = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '?' {
            let token_start = result
                .rfind(char::is_whitespace)
                .map(|index| index + 1)
                .unwrap_or(0);
            if result[token_start..].contains("://") {
                result.push_str("?<redacted>");
                while let Some(next) = chars.peek() {
                    if next.is_whitespace() {
                        break;
                    }
                    chars.next();
                }
                continue;
            }
        }
        result.push(ch);
    }
    result
}

fn redact_user_paths(line: &str) -> String {
    let mut output = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(index) = rest.find("\\Users\\") {
        let after = index + "\\Users\\".len();
        output.push_str(&rest[..after]);
        rest = &rest[after..];
        let end = rest.find('\\').unwrap_or(rest.len());
        if end > 0 {
            output.push_str("<user>");
            rest = &rest[end..];
        }
    }
    output.push_str(rest);
    output
}

pub fn redact_line(line: &str) -> String {
    let mut redacted = redact_url_queries(line);
    for key in SENSITIVE_KEYS {
        redacted = truncate_value(&redacted, key);
    }
    redact_user_paths(&redacted)
}

fn read_log_tail(log_dir: Option<&Path>) -> String {
    let Some(log_dir) = log_dir else {
        return "未找到日志目录。".into();
    };
    let Ok(entries) = fs::read_dir(log_dir) else {
        return "未找到日志文件。".into();
    };
    let mut logs: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with("bilipocket"))
                .unwrap_or(false)
        })
        .collect();
    logs.sort();
    let Some(path) = logs.last() else {
        return "未找到日志文件。".into();
    };
    let Ok(metadata) = fs::metadata(path) else {
        return "无法读取日志文件。".into();
    };
    let bytes = fs::read(path).unwrap_or_default();
    let start = bytes.len().saturating_sub(MAX_LOG_TAIL_BYTES as usize);
    let tail = String::from_utf8_lossy(&bytes[start..]);
    let lines: Vec<&str> = tail.lines().collect();
    let selected = &lines[lines.len().saturating_sub(MAX_LOG_LINES)..];
    let mut result = format!(
        "日志文件：{}（{} 字节，显示最后 {} 行）\n",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("bilipocket.log"),
        metadata.len(),
        selected.len()
    );
    for line in selected {
        result.push_str(&redact_line(line));
        result.push('\n');
    }
    result
}

fn count_statuses(tasks: &[Task]) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for task in tasks {
        *counts.entry(task.status.as_str().to_string()).or_insert(0) += 1;
    }
    if !counts.contains_key(TaskStatus::Failed.as_str()) {
        counts.insert(TaskStatus::Failed.as_str().into(), 0);
    }
    counts
}

#[allow(clippy::too_many_arguments)]
pub fn build_report(
    app_version: &str,
    engine: &EngineInfo,
    auth: &AuthStatus,
    settings: &Settings,
    tasks: &[Task],
    history_len: usize,
    log_dir: Option<&Path>,
    download_dir_writable: bool,
) -> String {
    let report = json!({
        "generatedAt": now_ms(),
        "appVersion": app_version,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "authorizedAccepted": settings.authorized_accepted,
        "engine": engine,
        "account": {
            "loggedIn": auth.logged_in,
            "vip": auth.account.as_ref().map(|account| account.vip).unwrap_or(false),
        },
        "settings": {
            "theme": &settings.theme,
            "maxConcurrent": settings.max_concurrent,
            "rateLimitKbps": settings.rate_limit_kbps,
            "preferredQuality": &settings.preferred_quality,
            "notifyOnComplete": settings.notify_on_complete,
            "minimizeToTray": settings.minimize_to_tray,
            "retryMax": settings.retry_max,
            "retryBaseSeconds": settings.retry_base_seconds,
            "fragmentRetries": settings.fragment_retries,
        },
        // 只暴露可写性，不暴露路径（见下方脱敏承诺）。
        "downloadDir": { "writable": download_dir_writable },
        "tasks": count_statuses(tasks),
        "historyCount": history_len,
    });
    format!(
        "BiliPocket 诊断报告（已脱敏，不含 Cookie、账号标识、下载目录或完整链接）\n\n{}\n\n最近日志：\n{}",
        serde_json::to_string_pretty(&report).unwrap_or_default(),
        read_log_tail(log_dir)
    )
}

#[allow(clippy::too_many_arguments)]
pub fn export(
    data_dir: &Path,
    app_version: &str,
    engine: &EngineInfo,
    auth: &AuthStatus,
    settings: &Settings,
    tasks: &[Task],
    history_len: usize,
    log_dir: Option<&Path>,
    download_dir_writable: bool,
) -> Result<PathBuf, String> {
    let directory = data_dir.join("diagnostics");
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建诊断目录：{error}"))?;
    let path = directory.join(format!("bilipocket-diagnostics-{}.txt", now_ms()));
    let report = build_report(
        app_version,
        engine,
        auth,
        settings,
        tasks,
        history_len,
        log_dir,
        download_dir_writable,
    );
    fs::write(&path, report).map_err(|error| format!("无法写入诊断文件：{error}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_url_queries_and_cookies() {
        let line = "GET https://api.bilibili.com/x/player?bvid=BV1xx&cid=123 SESSDATA=abc%3D; bili_jct=token";
        let redacted = redact_line(line);
        assert!(!redacted.contains("BV1xx"));
        assert!(!redacted.contains("abc%3D"));
        assert!(!redacted.contains("token"));
        assert!(redacted.contains("<redacted>"));
    }

    #[test]
    fn report_includes_writable_flag_without_path() {
        let engine = EngineInfo {
            available: true,
            yt_dlp_version: Some("2026.01.01".into()),
            ffmpeg_version: Some("7.0".into()),
            engine_path: Some("yt-dlp.exe".into()),
            message: None,
            problem: None,
        };
        let auth = AuthStatus {
            logged_in: false,
            account: None,
        };
        let settings = Settings::defaults("D:\\secret\\downloads".into());
        let report = build_report("0.9.0", &engine, &auth, &settings, &[], 0, None, false);

        assert!(report.contains("\"writable\": false"));
        // 报告承诺不含下载目录，只有布尔。
        assert!(!report.contains("secret"));
        assert!(report.contains("\"retryMax\": 3"));
        assert!(report.contains("\"fragmentRetries\": 5"));
    }

    #[test]
    fn redacts_user_paths() {
        let redacted =
            redact_line("log at C:\\Users\\alice\\AppData\\Local\\BiliPocket\\bilipocket.log");
        assert!(!redacted.contains("alice"));
        assert!(redacted.contains("C:\\Users\\<user>\\AppData"));
    }

    #[test]
    fn keeps_ordinary_diagnostics() {
        let line = "engine available=true version=2026.10.26";
        assert_eq!(redact_line(line), line);
    }
}
