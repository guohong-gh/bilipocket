use std::{env, fs, path::PathBuf, thread, time::Duration};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--version") {
        println!("fake-2026.1");
        return;
    }
    if args.iter().any(|arg| arg == "--dump-single-json") {
        let subtitles = serde_json::json!({
            "zh-Hans": [{"ext": "srt"}],
            "danmaku": [{"ext": "xml", "url": "https://comment.bilibili.com/123.xml"}]
        });
        println!(
            "{}",
            serde_json::json!({
                "id": "BV1xx411c7mD",
                "title": "端到端测试视频",
                "uploader": "测试 UP",
                "duration": 42,
                "thumbnail": "./assets/cover-placeholder.svg",
                "webpage_url": "https://www.bilibili.com/video/BV1xx411c7mD",
                "formats": [
                    {"format_id": "30216", "ext": "m4a", "vcodec": "none", "acodec": "mp4a.40.2", "filesize": 1000, "tbr": 69.0},
                    {"format_id": "30080", "ext": "mp4", "width": 1920, "height": 1080, "fps": 30, "vcodec": "avc1.640028", "acodec": "none", "filesize": 5000, "tbr": 1500.0},
                    {"format_id": "30016", "ext": "mp4", "width": 640, "height": 360, "fps": 30, "vcodec": "avc1.64001e", "acodec": "none", "filesize": 2000, "tbr": 300.0}
                ],
                "subtitles": subtitles
            })
        );
        return;
    }

    let mut output_template = None;
    let mut audio_only = false;
    let mut skip_download = false;
    let mut subtitle_langs = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "-o" => {
                output_template = args.get(index + 1).cloned();
                index += 2;
            }
            "--extract-audio" => {
                audio_only = true;
                index += 1;
            }
            "--skip-download" => {
                skip_download = true;
                index += 1;
            }
            "--sub-langs" => {
                if let Some(value) = args.get(index + 1) {
                    subtitle_langs = value.split(',').map(str::to_string).collect();
                }
                index += 2;
            }
            _ => index += 1,
        }
    }

    let template = output_template.unwrap_or_else(|| "download.%(ext)s".into());
    let extension = if audio_only { "mp3" } else { "mp4" };
    let path = PathBuf::from(template.replace("%(ext)s", extension));
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
        if env::var("FAKE_YTDLP_FAIL_ONCE").ok().as_deref() == Some("1") {
            let marker = parent.join(".fake-failed-once");
            if !marker.exists() {
                let _ = fs::write(&marker, b"1");
                eprintln!("ERROR: temporary network failure");
                std::process::exit(1);
            }
        }
    }

    if !skip_download {
        for step in 1..=5 {
            let downloaded = step * 200;
            println!("PROGRESS:{downloaded}|1000|50.0|{}", 5 - step);
            let delay = env::var("FAKE_YTDLP_STEP_MS")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(180);
            thread::sleep(Duration::from_millis(delay));
        }
        let _ = fs::write(&path, b"fake media file for integration testing");
    }
    for language in subtitle_langs {
        if language == "danmaku" {
            continue;
        }
        let subtitle = path.with_file_name(format!("download.{language}.srt"));
        let _ = fs::write(
            subtitle,
            "1
00:00:00,000 --> 00:00:02,000
测试字幕
",
        );
    }
    if !skip_download {
        println!("BILIPOCKET_FILE:{}", path.to_string_lossy());
    }
    thread::sleep(Duration::from_millis(200));
}
