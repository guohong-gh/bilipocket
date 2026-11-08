use std::{
    collections::BTreeMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use md5::{Digest, Md5};
use reqwest::{
    blocking::Client,
    header::{COOKIE, REFERER, USER_AGENT},
};
use serde_json::Value;
use thiserror::Error;

use crate::domain::{
    format_label_from_dimensions, normalize_bvid, now_ms, QualityOption, SeasonEpisode, SeasonInfo,
    VideoPage, VideoProbe,
};

const NAV_URL: &str = "https://api.bilibili.com/x/web-interface/nav";
const VIEW_URL: &str = "https://api.bilibili.com/x/web-interface/view";
const WBI_VIEW_URL: &str = "https://api.bilibili.com/x/web-interface/wbi/view";
const PLAYURL_URL: &str = "https://api.bilibili.com/x/player/wbi/playurl";
const USER_AGENT_VALUE: &str = "BiliPocket/0.9 (+local desktop client)";
/// WBI mixin key 在浏览器侧按天轮换，本地缓存 12 小时足够，且避免每次解析都打 nav。
const MIXIN_KEY_TTL: Duration = Duration::from_secs(12 * 60 * 60);
/// 只对风控/服务端错误做一次退避重试，避免放大限流。
const RETRY_BACKOFF: Duration = Duration::from_millis(1500);
const WBI_MIXIN_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

#[derive(Debug, Error)]
pub enum MetaError {
    #[error("network error: {0}")]
    Network(String),
    #[error("Bilibili metadata error: {0}")]
    Remote(String),
    /// 平台侧频率校验（HTTP 412 / code -352 / -412 / -799）。只能退避与提示，不做任何规避。
    #[error("Bilibili risk control: {0}")]
    RiskControl(String),
    #[error("Bilibili metadata parse error: {0}")]
    Parse(String),
}

impl MetaError {
    pub fn is_risk_control(&self) -> bool {
        matches!(self, MetaError::RiskControl(_))
    }
}

#[derive(Debug, Clone)]
pub struct QualityHint {
    pub qn: u32,
    pub label: String,
    pub height: u32,
    pub fps: f64,
    pub dynamic_range: Option<String>,
    pub accessible: bool,
    pub reason: Option<String>,
    pub size_bytes: Option<u64>,
    pub codec: Option<String>,
}

#[derive(Debug, Clone)]
pub struct QualityMatrix {
    pub hints: Vec<QualityHint>,
    pub audio_size: Option<u64>,
    pub view_count: Option<u64>,
    pub danmaku_count: Option<u64>,
    pub published_at: Option<i64>,
    /// 同一 BV 下的分 P，来自 view 响应的 `pages` 字段。
    pub pages: Vec<VideoPage>,
    /// 该视频所属合集，来自 view 响应的 `ugc_season` 字段。
    pub season: Option<SeasonInfo>,
}

/// view 接口 `data.pages` 已经是官方给出的分 P 清单，不需要 --flat-playlist，
/// 也不做收藏夹 / 空间 / 全站遍历。
fn parse_pages(data: &Value) -> Vec<VideoPage> {
    let Some(pages) = data.get("pages").and_then(Value::as_array) else {
        return Vec::new();
    };
    pages
        .iter()
        .filter_map(|page| {
            Some(VideoPage {
                index: page.get("page").and_then(Value::as_u64)? as u32,
                cid: page.get("cid").and_then(Value::as_u64)?,
                title: page
                    .get("part")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                duration_seconds: page.get("duration").and_then(Value::as_u64),
            })
        })
        .collect()
}

/// 合集（`ugc_season`）解析。
/// 与分 P 不同：同一个合集里的每一条都是**独立 BV**。
/// view 接口一次性返回全部 section 与条目，所以这里是纯解析，不产生额外请求、不分页。
fn parse_season(data: &Value) -> Option<SeasonInfo> {
    let season = data.get("ugc_season").filter(|value| value.is_object())?;
    let sections = season
        .get("sections")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut episodes: Vec<SeasonEpisode> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for section in sections {
        let section_title = section
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let section_episodes = section
            .get("episodes")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        for episode in section_episodes {
            let arc = episode.get("arc");
            // 条目自身的 `bvid` 是权威来源；个别响应只在 `arc` 下给出。
            let bvid = episode
                .get("bvid")
                .and_then(Value::as_str)
                .or_else(|| {
                    arc.and_then(|value| value.get("bvid"))
                        .and_then(Value::as_str)
                })
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let Some(bvid) = bvid else { continue };
            // 「最新 N 期」这类 section 会与其他 section 重复收录同一条，按 bvid 去重。
            if !seen.insert(bvid.to_string()) {
                continue;
            }
            let title = arc
                .and_then(|value| value.get("title"))
                .and_then(Value::as_str)
                .or_else(|| episode.get("title").and_then(Value::as_str))
                .unwrap_or("")
                .to_string();
            let duration_seconds = arc
                .and_then(|value| value.get("duration"))
                .and_then(Value::as_u64)
                .or_else(|| {
                    episode
                        .get("page")
                        .and_then(|value| value.get("duration"))
                        .and_then(Value::as_u64)
                });
            episodes.push(SeasonEpisode {
                bvid: bvid.to_string(),
                title,
                duration_seconds,
                cover_url: arc
                    .and_then(|value| value.get("pic"))
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
                published_at: arc
                    .and_then(|value| value.get("pubdate"))
                    .and_then(Value::as_i64)
                    .filter(|value| *value > 0),
                section: section_title.clone(),
            });
        }
    }
    if episodes.is_empty() {
        return None;
    }
    Some(SeasonInfo {
        id: season.get("id").and_then(Value::as_i64).unwrap_or(0),
        title: season
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        episodes,
    })
}

fn client() -> Result<Client, MetaError> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(USER_AGENT_VALUE)
        .build()
        .map_err(|error| MetaError::Network(error.to_string()))
}

/// B 站用这些业务码表达"请求过频"，与 HTTP 412 等价。
fn is_risk_code(code: i64) -> bool {
    matches!(code, -352 | -412 | -799)
}

fn is_risk_control_body(body: &Value) -> bool {
    body.get("code")
        .and_then(Value::as_i64)
        .map(is_risk_code)
        .unwrap_or(false)
}

fn is_retryable(error: &MetaError) -> bool {
    // 只重试服务端 5xx。412 / -352 属于频率校验，重试只会加重限流，
    // 交由上层降级（wbi → 旧端点）与队列退避处理。
    matches!(error, MetaError::Remote(message) if message.starts_with("HTTP 5"))
}

fn get_json_once(
    client: &Client,
    url: reqwest::Url,
    cookie: Option<&str>,
) -> Result<Value, MetaError> {
    let mut request = client
        .get(url)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .header(REFERER, "https://www.bilibili.com/");
    if let Some(cookie) = cookie {
        request = request.header(COOKIE, cookie);
    }
    let response = request
        .send()
        .map_err(|error| MetaError::Network(error.to_string()))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        return Err(if status == 412 || status == 429 {
            MetaError::RiskControl(format!("HTTP {status}"))
        } else {
            MetaError::Remote(format!("HTTP {status}"))
        });
    }
    let body: Value = response
        .json()
        .map_err(|error| MetaError::Network(error.to_string()))?;
    if is_risk_control_body(&body) {
        return Err(MetaError::RiskControl("响应包含风控业务码".into()));
    }
    Ok(body)
}

/// 5xx 重试一次；其余错误（含风控）立即返回。
fn get_json(client: &Client, url: reqwest::Url, cookie: Option<&str>) -> Result<Value, MetaError> {
    match get_json_once(client, url.clone(), cookie) {
        Err(error) if is_retryable(&error) => {
            log::warn!("B 站接口返回 {error}，退避后重试一次");
            std::thread::sleep(RETRY_BACKOFF);
            get_json_once(client, url, cookie)
        }
        other => other,
    }
}

fn key_from_url(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw).ok()?;
    let name = url.path_segments()?.next_back()?;
    Some(name.split('.').next()?.to_string())
}

fn wbi_mixin_key(client: &Client, cookie: Option<&str>) -> Result<String, MetaError> {
    let url = reqwest::Url::parse(NAV_URL).map_err(|error| MetaError::Parse(error.to_string()))?;
    let body = get_json(client, url, cookie)?;
    let image = body
        .pointer("/data/wbi_img/img_url")
        .and_then(Value::as_str)
        .and_then(key_from_url)
        .ok_or_else(|| MetaError::Remote("nav 未返回 WBI 图片密钥".into()))?;
    let sub = body
        .pointer("/data/wbi_img/sub_url")
        .and_then(Value::as_str)
        .and_then(key_from_url)
        .ok_or_else(|| MetaError::Remote("nav 未返回 WBI 子密钥".into()))?;
    let raw = format!("{image}{sub}");
    if raw.len() < 64 {
        return Err(MetaError::Remote("WBI 密钥长度不足".into()));
    }
    Ok(WBI_MIXIN_TAB
        .iter()
        .map(|index| raw.chars().nth(*index).unwrap_or_default())
        .take(32)
        .collect())
}

struct CachedMixinKey {
    key: String,
    fetched_at: Instant,
}

struct MixinKeyCache {
    entry: Option<CachedMixinKey>,
}

impl MixinKeyCache {
    fn read(&self, ttl: Duration) -> Option<String> {
        let entry = self.entry.as_ref()?;
        (entry.fetched_at.elapsed() < ttl).then(|| entry.key.clone())
    }

    fn write(&mut self, key: &str) {
        self.entry = Some(CachedMixinKey {
            key: key.to_string(),
            fetched_at: Instant::now(),
        });
    }

    fn clear(&mut self) {
        self.entry = None;
    }
}

static MIXIN_KEY_CACHE: Mutex<MixinKeyCache> = Mutex::new(MixinKeyCache { entry: None });

/// 同一进程内复用 mixin key，避免每次解析都额外请求 nav（也是风控暴露面之一）。
fn cached_mixin_key(client: &Client, cookie: Option<&str>) -> Result<String, MetaError> {
    if let Ok(cache) = MIXIN_KEY_CACHE.lock() {
        if let Some(key) = cache.read(MIXIN_KEY_TTL) {
            return Ok(key);
        }
    }
    let key = wbi_mixin_key(client, cookie)?;
    if let Ok(mut cache) = MIXIN_KEY_CACHE.lock() {
        cache.write(&key);
    }
    Ok(key)
}

fn clear_mixin_key_cache() {
    if let Ok(mut cache) = MIXIN_KEY_CACHE.lock() {
        cache.clear();
        log::warn!("已清空 WBI 密钥缓存，下次解析将重新获取");
    }
}

fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('!', "%21")
        .replace('\'', "%27")
        .replace('(', "%28")
        .replace(')', "%29")
        .replace('*', "%2A")
}

fn signed_query(params: &BTreeMap<String, String>, mixin_key: &str) -> String {
    let query = params
        .iter()
        .map(|(key, value)| format!("{}={}", encode(key), encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    let digest = Md5::digest(format!("{query}{mixin_key}").as_bytes());
    format!("{query}&w_rid={digest:x}")
}

pub fn quality_label(qn: u32, display_desc: &str) -> String {
    match qn {
        127 => "8K".into(),
        126 => "杜比视界".into(),
        125 => "HDR".into(),
        120 => "4K".into(),
        116 => "1080P60".into(),
        112 => "1080P+".into(),
        80 => "1080P".into(),
        74 => "720P60".into(),
        64 => "720P".into(),
        32 => "480P".into(),
        16 => "360P".into(),
        6 => "240P".into(),
        _ => {
            let value = display_desc.trim();
            if value.is_empty() {
                format!("QN {qn}")
            } else {
                value.to_string()
            }
        }
    }
}

pub fn quality_height(qn: u32) -> u32 {
    match qn {
        127 => 4320,
        126 | 125 | 120 => 2160,
        116 | 112 | 80 => 1080,
        74 | 64 => 720,
        32 => 480,
        16 => 360,
        6 => 240,
        _ => 0,
    }
}

pub fn quality_fps(qn: u32) -> f64 {
    match qn {
        116 | 74 => 60.0,
        _ => 30.0,
    }
}

fn quality_dynamic_range(qn: u32) -> Option<String> {
    match qn {
        126 => Some("DV".into()),
        125 => Some("HDR10".into()),
        _ => None,
    }
}

pub fn locked_reason(qn: u32) -> &'static str {
    match qn {
        112 | 116 | 120 | 125 | 126 | 127 => "大会员专享",
        74 | 80 | 64 => "登录后可下载",
        _ => "当前账号不可用",
    }
}

fn qn_from_format_id(format_id: &str) -> Option<u32> {
    if format_id.len() == 5 && format_id.starts_with("300") {
        format_id[3..].parse().ok()
    } else {
        None
    }
}

fn pick_stream<'a>(streams: &'a [&Value]) -> Option<&'a Value> {
    streams.iter().copied().max_by(|left, right| {
        let score = |stream: &Value| {
            let codec = stream
                .get("codecs")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase();
            let codec_rank = if codec.starts_with("avc") || codec.starts_with("h264") {
                2
            } else if codec.starts_with("hev") || codec.starts_with("hvc") {
                1
            } else {
                0
            };
            (
                codec_rank,
                stream.get("bandwidth").and_then(Value::as_u64).unwrap_or(0),
            )
        };
        score(left).cmp(&score(right))
    })
}

/// 单条档位的元信息。`display` 来自接口文案，`dash_*` 来自实际流，用于未知档位兜底。
struct HintMeta {
    display: String,
    dash_height: Option<u32>,
    dash_fps: Option<f64>,
}

fn is_plausible_qn(qn: u32) -> bool {
    qn > 0 && qn < 1_000_000
}

fn has_playable_url(video: &Value) -> bool {
    let non_empty = |key: &str| {
        video
            .get(key)
            .and_then(Value::as_str)
            .map(|url| !url.is_empty())
            .unwrap_or(false)
    };
    if non_empty("baseUrl") || non_empty("base_url") {
        return true;
    }
    video
        .get("backupUrl")
        .or_else(|| video.get("backup_url"))
        .and_then(Value::as_array)
        .map(|urls| {
            urls.iter()
                .any(|url| url.as_str().map(|value| !value.is_empty()).unwrap_or(false))
        })
        .unwrap_or(false)
}

fn parse_frame_rate(video: &Value) -> Option<f64> {
    let raw = video.get("frameRate").or_else(|| video.get("frame_rate"))?;
    if let Some(text) = raw.as_str() {
        if let Some((numerator, denominator)) = text.split_once('/') {
            let numerator: f64 = numerator.trim().parse().ok()?;
            let denominator: f64 = denominator.trim().parse().ok()?;
            return (denominator > 0.0).then(|| numerator / denominator);
        }
        return text.trim().parse().ok();
    }
    raw.as_f64()
}

/// 未知档位的可读名复用 domain 的实现；高度未知时返回 None，由调用方回退到 `QN {qn}`。
fn derived_label(height: u32, fps: Option<f64>) -> Option<String> {
    if height == 0 {
        return None;
    }
    format_label_from_dimensions(Some(height), fps)
}

fn build_matrix(value: &Value, duration_seconds: Option<u64>) -> Result<QualityMatrix, MetaError> {
    let data = value
        .get("data")
        .ok_or_else(|| MetaError::Remote("playurl 响应缺少 data".into()))?;

    // 档位来源是三源并集，优先级即顺序：接口文案 → 可接受列表 → 实际返回的流。
    // support_formats 会漏档（见 yutto#543），只信它会让"账号明明能拿到"的档位整行消失。
    let mut hint_meta: BTreeMap<u32, HintMeta> = BTreeMap::new();
    if let Some(formats) = data.get("support_formats").and_then(Value::as_array) {
        for format in formats {
            let Some(qn) = format.get("quality").and_then(Value::as_u64) else {
                continue;
            };
            let qn = qn as u32;
            if !is_plausible_qn(qn) {
                continue;
            }
            let display = format
                .get("display_desc")
                .and_then(Value::as_str)
                .or_else(|| format.get("new_description").and_then(Value::as_str))
                .unwrap_or_default();
            hint_meta.entry(qn).or_insert_with(|| HintMeta {
                display: display.to_string(),
                dash_height: None,
                dash_fps: None,
            });
        }
    }
    {
        let qualities = data
            .get("accept_quality")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let descriptions = data
            .get("accept_description")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (index, qn) in qualities.iter().enumerate() {
            let Some(qn) = qn.as_u64() else { continue };
            let qn = qn as u32;
            if !is_plausible_qn(qn) {
                continue;
            }
            let display = descriptions
                .get(index)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            hint_meta.entry(qn).or_insert_with(|| HintMeta {
                display,
                dash_height: None,
                dash_fps: None,
            });
        }
    }

    let duration = duration_seconds
        .or_else(|| {
            data.get("timelength")
                .and_then(Value::as_u64)
                .map(|ms| ms / 1000)
        })
        .unwrap_or(0);

    let mut streams: BTreeMap<u32, Vec<&Value>> = BTreeMap::new();
    let mut accessible = std::collections::BTreeSet::new();
    if let Some(videos) = data.pointer("/dash/video").and_then(Value::as_array) {
        for video in videos {
            let Some(qn) = video.get("id").and_then(Value::as_u64) else {
                continue;
            };
            let qn = qn as u32;
            if !is_plausible_qn(qn) {
                continue;
            }
            if !has_playable_url(video) {
                continue;
            }
            accessible.insert(qn);
            streams.entry(qn).or_default().push(video);
            let meta = hint_meta.entry(qn).or_insert_with(|| HintMeta {
                display: String::new(),
                dash_height: None,
                dash_fps: None,
            });
            if meta.dash_height.is_none() {
                meta.dash_height = video
                    .get("height")
                    .and_then(Value::as_u64)
                    .map(|height| height as u32);
            }
            if meta.dash_fps.is_none() {
                meta.dash_fps = parse_frame_rate(video);
            }
        }
    } else if let Some(qn) = data.get("quality").and_then(Value::as_u64) {
        accessible.insert(qn as u32);
    }

    if hint_meta.is_empty() {
        return Err(MetaError::Remote("playurl 未返回支持的清晰度".into()));
    }

    // 已知档或接口给了文案的标签优先占位，派生标签撞名时再加后缀，避免
    // apply_quality_matrix 按 label 去重时把新档整条吞掉。
    let mut reserved = std::collections::BTreeSet::new();
    for (qn, meta) in &hint_meta {
        if !meta.display.trim().is_empty() || quality_height(*qn) > 0 {
            reserved.insert(quality_label(*qn, &meta.display));
        }
    }

    let audio_base = data
        .pointer("/dash/audio")
        .and_then(Value::as_array)
        .and_then(|audio| {
            audio
                .iter()
                .max_by_key(|stream| stream.get("bandwidth").and_then(Value::as_u64).unwrap_or(0))
        })
        .and_then(|stream| stream.get("bandwidth").and_then(Value::as_u64));
    let audio_size = audio_base
        .filter(|_| duration > 0)
        .map(|bandwidth| bandwidth.saturating_mul(duration) / 8);

    let mut used_labels = reserved;
    let mut hints = hint_meta
        .into_iter()
        .map(|(qn, meta)| {
            let known_height = quality_height(qn);
            let height = if known_height > 0 {
                known_height
            } else {
                meta.dash_height.unwrap_or(0)
            };
            let fps = quality_fps(qn).max(meta.dash_fps.unwrap_or(0.0));
            let base_label = quality_label(qn, &meta.display);
            let derived = meta.display.trim().is_empty() && known_height == 0;
            let label = if derived {
                let mut candidate = derived_label(height, meta.dash_fps).unwrap_or(base_label);
                if used_labels.contains(&candidate) {
                    candidate = format!("{candidate} · QN{qn}");
                }
                used_labels.insert(candidate.clone());
                candidate
            } else {
                used_labels.insert(base_label.clone());
                base_label
            };
            let selected = streams
                .get(&qn)
                .and_then(|items| pick_stream(items.as_slice()));
            let bandwidth =
                selected.and_then(|stream| stream.get("bandwidth").and_then(Value::as_u64));
            let size_bytes = if accessible.contains(&qn) {
                bandwidth.filter(|_| duration > 0).map(|bandwidth| {
                    let video = bandwidth.saturating_mul(duration) / 8;
                    video + audio_size.unwrap_or(0)
                })
            } else {
                None
            };
            let codec = selected
                .and_then(|stream| stream.get("codecs").and_then(Value::as_str))
                .map(str::to_string);
            let is_accessible = accessible.contains(&qn);
            QualityHint {
                qn,
                label,
                height,
                fps,
                dynamic_range: quality_dynamic_range(qn),
                accessible: is_accessible,
                reason: if is_accessible {
                    None
                } else {
                    Some(locked_reason(qn).to_string())
                },
                size_bytes,
                codec,
            }
        })
        .collect::<Vec<_>>();
    hints.sort_by_key(|hint| std::cmp::Reverse(hint.qn));

    Ok(QualityMatrix {
        hints,
        audio_size,
        pages: Vec::new(),
        season: None,
        view_count: None,
        danmaku_count: None,
        published_at: None,
    })
}

fn view_error(body: &Value, endpoint: &str) -> MetaError {
    MetaError::Remote(format!(
        "{endpoint}: {}",
        body.get("message")
            .and_then(Value::as_str)
            .unwrap_or("view 接口失败")
    ))
}

/// 带 WBI 签名的 view 端点。风控类失败会以 `RiskControl` 返回，由 `fetch_view` 降级。
fn fetch_view_wbi(client: &Client, bvid: &str, cookie: Option<&str>) -> Result<Value, MetaError> {
    let mixin_key = cached_mixin_key(client, cookie)?;
    let mut params = BTreeMap::new();
    params.insert("bvid".into(), bvid.to_string());
    params.insert("wts".into(), (now_ms() / 1000).to_string());
    let query = signed_query(&params, &mixin_key);
    let url = reqwest::Url::parse(&format!("{WBI_VIEW_URL}?{query}"))
        .map_err(|error| MetaError::Parse(error.to_string()))?;
    let body = get_json(client, url, cookie)?;
    if body.get("code").and_then(Value::as_i64).unwrap_or(-1) != 0 {
        return Err(view_error(&body, "wbi/view"));
    }
    Ok(body)
}

fn fetch_view_legacy(
    client: &Client,
    bvid: &str,
    cookie: Option<&str>,
) -> Result<Value, MetaError> {
    let mut url =
        reqwest::Url::parse(VIEW_URL).map_err(|error| MetaError::Parse(error.to_string()))?;
    url.query_pairs_mut().append_pair("bvid", bvid);
    let body = get_json(client, url, cookie)?;
    if body.get("code").and_then(Value::as_i64).unwrap_or(-1) != 0 {
        return Err(view_error(&body, "view"));
    }
    Ok(body)
}

/// 主路径走 wbi/view；只有风控类失败才退回旧端点，且只退一次。
fn fetch_view(client: &Client, bvid: &str, cookie: Option<&str>) -> Result<Value, MetaError> {
    match fetch_view_wbi(client, bvid, cookie) {
        Ok(view) => Ok(view),
        Err(error) if error.is_risk_control() => {
            log::warn!("wbi/view 触发风控（{error}），本次降级到旧端点");
            clear_mixin_key_cache();
            fetch_view_legacy(client, bvid, cookie)
        }
        Err(error) => Err(error),
    }
}

pub fn fetch_quality_matrix(
    bvid: &str,
    cookie_header: Option<&str>,
) -> Result<QualityMatrix, MetaError> {
    let bvid =
        normalize_bvid(bvid).ok_or_else(|| MetaError::Parse(format!("无效的 BVID：{bvid}")))?;
    let client = client()?;
    let view = fetch_view(&client, &bvid, cookie_header)?;
    let data = view
        .get("data")
        .ok_or_else(|| MetaError::Remote("view 响应缺少 data".into()))?;
    let cid = data
        .get("cid")
        .and_then(Value::as_u64)
        .ok_or_else(|| MetaError::Remote("view 响应缺少 cid".into()))?;
    let duration = data.get("duration").and_then(Value::as_u64);

    let mixin_key = cached_mixin_key(&client, cookie_header)?;
    let mut params = BTreeMap::new();
    params.insert("bvid".into(), bvid.to_string());
    params.insert("cid".into(), cid.to_string());
    params.insert("fnval".into(), "4048".into());
    params.insert("fnver".into(), "0".into());
    params.insert("fourk".into(), "1".into());
    params.insert("platform".into(), "pc".into());
    params.insert("qn".into(), "127".into());
    params.insert("wts".into(), (now_ms() / 1000).to_string());
    let query = signed_query(&params, &mixin_key);
    let url = reqwest::Url::parse(&format!("{PLAYURL_URL}?{query}"))
        .map_err(|error| MetaError::Parse(error.to_string()))?;
    let view_count = data.pointer("/stat/view").and_then(Value::as_u64);
    let danmaku_count = data.pointer("/stat/danmaku").and_then(Value::as_u64);
    let published_at = data.get("pubdate").and_then(Value::as_i64);
    let playurl = get_json(&client, url, cookie_header)?;
    if playurl.get("code").and_then(Value::as_i64).unwrap_or(-1) != 0 {
        return Err(MetaError::Remote(format!(
            "playurl({bvid}, cid={cid}): {}",
            playurl
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("playurl 接口失败")
        )));
    }
    let mut matrix = build_matrix(&playurl, duration)?;
    matrix.view_count = view_count;
    matrix.danmaku_count = danmaku_count;
    matrix.published_at = published_at;
    matrix.pages = parse_pages(data);
    matrix.season = parse_season(data);
    Ok(matrix)
}

/// T10：读取播放器章节（view_points）。null / 缺失 / 接口失败都返回空，
/// 不产生额外错误噪音；开关关闭时调用方根本不会请求这里。
pub fn fetch_view_points(
    bvid: &str,
    cid: u64,
    cookie_header: Option<&str>,
) -> Vec<crate::postprocess::Chapter> {
    let Ok(client) = client() else {
        return Vec::new();
    };
    let Ok(mut url) = reqwest::Url::parse("https://api.bilibili.com/x/player/v2") else {
        return Vec::new();
    };
    url.query_pairs_mut()
        .append_pair("bvid", bvid)
        .append_pair("cid", &cid.to_string());
    let Ok(body) = get_json(&client, url, cookie_header) else {
        return Vec::new();
    };
    if body.get("code").and_then(Value::as_i64).unwrap_or(-1) != 0 {
        return Vec::new();
    }
    let Some(points) = body.pointer("/data/view_points").and_then(Value::as_array) else {
        return Vec::new();
    };
    points
        .iter()
        .filter_map(|point| {
            let from = point.get("from").and_then(Value::as_u64)?;
            let to = point.get("to").and_then(Value::as_u64)?;
            if to <= from {
                return None;
            }
            Some(crate::postprocess::Chapter {
                title: point
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or("章节")
                    .to_string(),
                start_seconds: from,
                end_seconds: to,
            })
        })
        .collect()
}

fn hint_matches(quality: &QualityOption, hint: &QualityHint) -> bool {
    if hint.dynamic_range.is_some() {
        return quality.dynamic_range == hint.dynamic_range;
    }
    if quality.dynamic_range.is_some() {
        return false;
    }
    let height = quality.height.unwrap_or(0);
    let height_matches = match hint.qn {
        32 => (360..=480).contains(&height),
        16 => (240..=360).contains(&height),
        6 => (144..=240).contains(&height),
        _ => height.abs_diff(hint.height) <= 24,
    };
    if !height_matches {
        return false;
    }
    match hint.qn {
        116 | 74 => quality.fps.map(|fps| fps >= 50.0).unwrap_or(false),
        _ => quality.fps.map(|fps| fps < 50.0).unwrap_or(true),
    }
}

pub fn apply_quality_matrix(probe: &mut VideoProbe, matrix: &QualityMatrix) {
    if matrix.hints.is_empty() {
        return;
    }
    let mut video_options = probe
        .qualities
        .iter()
        .filter(|quality| !quality.audio_only && quality.accessible)
        .cloned()
        .collect::<Vec<_>>();
    let mut audio_options = probe
        .qualities
        .iter()
        .filter(|quality| quality.audio_only && quality.accessible)
        .cloned()
        .collect::<Vec<_>>();

    let mut matched: Vec<Option<QualityOption>> = vec![None; matrix.hints.len()];
    for (index, hint) in matrix.hints.iter().enumerate() {
        let direct_id = (30000 + hint.qn).to_string();
        if let Some(position) = video_options.iter().position(|quality| {
            quality.format_id == direct_id || qn_from_format_id(&quality.format_id) == Some(hint.qn)
        }) {
            matched[index] = Some(video_options.remove(position));
        }
    }
    let mut heuristic_indices = (0..matrix.hints.len())
        .filter(|index| matched[*index].is_none())
        .collect::<Vec<_>>();
    // 同一高度/帧率可能对应多个档位（如 1080P 与 1080P+）。从低档开始认领，
    // 避免高码率档抢占引擎唯一返回的那一路流，把基础档误判为“引擎不支持”。
    heuristic_indices.sort_by_key(|index| {
        let hint = &matrix.hints[*index];
        (hint.height, if hint.fps >= 50.0 { 1 } else { 0 }, hint.qn)
    });
    for index in heuristic_indices {
        if let Some(position) = video_options
            .iter()
            .position(|quality| hint_matches(quality, &matrix.hints[index]))
        {
            matched[index] = Some(video_options.remove(position));
        }
    }

    let mut merged: Vec<QualityOption> = Vec::new();
    for (index, hint) in matrix.hints.iter().enumerate() {
        if let Some(mut quality) = matched[index].take() {
            quality.label = hint.label.clone();
            quality.height = Some(hint.height);
            quality.fps = Some(hint.fps);
            quality.dynamic_range = hint.dynamic_range.clone().or(quality.dynamic_range);
            quality.size_bytes = quality.size_bytes.or(hint.size_bytes);
            if hint.accessible {
                quality.accessible = true;
                quality.reason = None;
                if quality.codec.is_empty() {
                    if let Some(codec) = hint.codec.clone() {
                        quality.codec = codec;
                    }
                }
            } else {
                quality.accessible = false;
                quality.reason = hint.reason.clone();
            }
            merged.push(quality);
            continue;
        }

        let (accessible, reason) = if hint.accessible {
            (
                false,
                Some("引擎未返回该档独立流，可能与其它清晰度共用同一路流".to_string()),
            )
        } else {
            (false, hint.reason.clone())
        };
        merged.push(QualityOption {
            format_id: format!("locked-{}", hint.qn),
            audio_format_id: None,
            label: hint.label.clone(),
            resolution: None,
            width: None,
            height: Some(hint.height),
            fps: Some(hint.fps),
            codec: hint.codec.clone().unwrap_or_else(|| "locked".into()),
            container: "mp4".into(),
            size_bytes: hint.size_bytes,
            audio_only: false,
            dynamic_range: hint.dynamic_range.clone(),
            note: Some("清晰度矩阵来自 B 站 playurl".into()),
            accessible,
            reason,
        });
    }

    video_options.sort_by(|left, right| {
        right
            .height
            .unwrap_or_default()
            .cmp(&left.height.unwrap_or_default())
    });
    for quality in video_options {
        if merged.iter().any(|item| item.label == quality.label) {
            continue;
        }
        merged.push(quality);
    }

    if let Some(size) = matrix.audio_size {
        for audio in &mut audio_options {
            if audio.size_bytes.is_none() {
                audio.size_bytes = Some(size);
            }
        }
    }
    merged.extend(audio_options);

    probe.recommended_quality = merged
        .iter()
        .find(|quality| quality.accessible && quality.label == "1080P")
        .or_else(|| {
            merged
                .iter()
                .find(|quality| quality.accessible && !quality.audio_only)
        })
        .or_else(|| merged.iter().find(|quality| quality.accessible))
        .map(|quality| quality.format_id.clone());
    probe.qualities = merged;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{DanmakuInfo, SubtitleTrack, VideoProbe};

    fn fixture(value: Value) -> QualityMatrix {
        build_matrix(&value, Some(2055)).unwrap()
    }

    #[test]
    fn parses_season_episodes_across_sections() {
        // 结构取自真实 view 响应（合集「奇人议事」的实际字段布局）。
        let view = serde_json::json!({
            "ugc_season": {
                "id": 360971,
                "title": "奇人议事",
                "sections": [
                    {
                        "title": "议事",
                        "episodes": [
                            {
                                "bvid": "BV1aa411c7aa",
                                "title": "条目标题不会被用到",
                                "arc": {
                                    "title": "第一集",
                                    "duration": 950,
                                    "pubdate": 1737463552,
                                    "pic": "https://i0.hdslb.com/a.jpg"
                                }
                            },
                            {
                                "bvid": "BV1bb411c7bb",
                                "arc": { "title": "第二集", "duration": 600 }
                            }
                        ]
                    },
                    {
                        "title": "传奇军舰",
                        "episodes": [
                            { "bvid": "BV1cc411c7cc", "arc": { "title": "第三集" } }
                        ]
                    }
                ]
            }
        });
        let season = parse_season(&view).expect("应解析出合集");
        assert_eq!(season.id, 360971);
        assert_eq!(season.title, "奇人议事");
        assert_eq!(season.episodes.len(), 3);
        assert_eq!(season.episodes[0].bvid, "BV1aa411c7aa");
        assert_eq!(season.episodes[0].title, "第一集");
        assert_eq!(season.episodes[0].duration_seconds, Some(950));
        assert_eq!(season.episodes[0].published_at, Some(1737463552));
        assert_eq!(
            season.episodes[0].cover_url.as_deref(),
            Some("https://i0.hdslb.com/a.jpg")
        );
        assert_eq!(season.episodes[0].section, "议事");
        assert_eq!(season.episodes[2].section, "传奇军舰");
        assert_eq!(season.episodes[2].duration_seconds, None);
    }

    #[test]
    fn season_deduplicates_episodes_repeated_in_latest_sections() {
        // 「最新 N 期」这类 section 会把别处已经收录的条目再列一遍。
        let view = serde_json::json!({
            "ugc_season": {
                "id": 1,
                "title": "合集",
                "sections": [
                    { "title": "正片", "episodes": [{ "bvid": "BV1aa", "arc": { "title": "一" } }] },
                    {
                        "title": "最新",
                        "episodes": [
                            { "bvid": "BV1aa", "arc": { "title": "一" } },
                            { "bvid": "BV1bb", "arc": { "title": "二" } }
                        ]
                    }
                ]
            }
        });
        let season = parse_season(&view).expect("应解析出合集");
        assert_eq!(season.episodes.len(), 2);
        assert_eq!(season.episodes[0].bvid, "BV1aa");
        assert_eq!(season.episodes[1].bvid, "BV1bb");
    }

    #[test]
    fn season_skips_entries_without_bvid_and_handles_missing_fields() {
        let view = serde_json::json!({
            "ugc_season": {
                "id": 2,
                "sections": [
                    {
                        "episodes": [
                            { "title": "没有 bvid" },
                            { "bvid": "   ", "arc": { "title": "空白 bvid" } },
                            { "bvid": "BV1ok", "arc": { "bvid": "BV1ignored", "title": "有效条目" } }
                        ]
                    }
                ]
            }
        });
        let season = parse_season(&view).expect("应解析出合集");
        assert_eq!(season.episodes.len(), 1);
        assert_eq!(season.episodes[0].bvid, "BV1ok");
        // 条目的 bvid 优先于 arc 里的值。
        assert_eq!(season.episodes[0].title, "有效条目");
        assert_eq!(season.title, "", "缺少 title 时不能 panic");
        assert_eq!(season.episodes[0].section, "", "缺少 section 标题时为空串");
    }

    #[test]
    fn season_falls_back_to_arc_bvid_when_top_level_is_missing() {
        let view = serde_json::json!({
            "ugc_season": {
                "id": 3,
                "title": "合集",
                "sections": [
                    { "title": "正片", "episodes": [{ "arc": { "bvid": "BV1arc", "title": "来自 arc" } }] }
                ]
            }
        });
        let season = parse_season(&view).expect("应解析出合集");
        assert_eq!(season.episodes.len(), 1);
        assert_eq!(season.episodes[0].bvid, "BV1arc");
    }

    #[test]
    fn no_season_or_empty_season_is_none_not_an_error() {
        assert!(parse_season(&serde_json::json!({})).is_none());
        assert!(parse_season(&serde_json::json!({ "ugc_season": null })).is_none());
        assert!(parse_season(&serde_json::json!({ "ugc_season": { "id": 1 } })).is_none());
        assert!(parse_season(&serde_json::json!({
            "ugc_season": { "id": 1, "sections": [{ "title": "空", "episodes": [] }] }
        }))
        .is_none());
    }

    #[test]
    fn parses_pages_from_view_response() {
        // 结构取自真实 view 响应（BV1W7wYetEga），单 P 视频。
        let view = serde_json::json!({
            "title": "示例",
            "pages": [{ "page": 1, "cid": 25747069954_u64, "part": "第一集", "duration": 950 }]
        });
        let pages = parse_pages(&view);
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].index, 1);
        assert_eq!(pages[0].cid, 25747069954);
        assert_eq!(pages[0].title, "第一集");
        assert_eq!(pages[0].duration_seconds, Some(950));
    }

    #[test]
    fn multi_page_view_keeps_all_pages_in_order() {
        let view = serde_json::json!({
            "pages": [
                { "page": 1, "cid": 1, "part": "P1", "duration": 10 },
                { "page": 2, "cid": 2, "part": "P2", "duration": 20 },
                { "page": 3, "cid": 3, "part": "P3", "duration": 30 }
            ]
        });
        let pages = parse_pages(&view);
        assert_eq!(
            pages.iter().map(|p| p.index).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(pages[2].title, "P3");
    }

    #[test]
    fn null_or_missing_pages_is_empty_not_an_error() {
        assert!(parse_pages(&serde_json::json!({ "pages": null })).is_empty());
        assert!(parse_pages(&serde_json::json!({})).is_empty());
    }

    fn playurl_fixture() -> Value {
        serde_json::json!({
            "code": 0,
            "data": {
                "quality": 32,
                "accept_quality": [125, 120, 116, 80, 64, 32, 16],
                "support_formats": [
                    {"quality": 125, "display_desc": "HDR"},
                    {"quality": 120, "display_desc": "4K"},
                    {"quality": 116, "display_desc": "1080P"},
                    {"quality": 80, "display_desc": "1080P"},
                    {"quality": 64, "display_desc": "720P"},
                    {"quality": 32, "display_desc": "480P"},
                    {"quality": 16, "display_desc": "360P"}
                ],
                "dash": {
                    "video": [
                        {"id": 32, "baseUrl": "https://example.invalid/480", "bandwidth": 155817, "codecs": "avc1.64001E", "width": 852, "height": 480},
                        {"id": 32, "baseUrl": "https://example.invalid/480-hevc", "bandwidth": 100000, "codecs": "hev1.1.6", "width": 852, "height": 480},
                        {"id": 16, "baseUrl": "https://example.invalid/360", "bandwidth": 120000, "codecs": "avc1.64001E", "width": 640, "height": 360}
                    ],
                    "audio": [
                        {"id": 30232, "bandwidth": 134695, "codecs": "mp4a.40.2"},
                        {"id": 30216, "bandwidth": 68646, "codecs": "mp4a.40.2"}
                    ]
                }
            }
        })
    }

    #[test]
    fn parses_support_formats_and_guest_access() {
        let matrix = fixture(playurl_fixture());
        assert_eq!(matrix.hints.len(), 7);
        let accessible = matrix.hints.iter().filter(|hint| hint.accessible).count();
        assert_eq!(accessible, 2);
        let hd = matrix.hints.iter().find(|hint| hint.qn == 80).unwrap();
        assert_eq!(hd.label, "1080P");
        assert!(!hd.accessible);
        assert_eq!(hd.reason.as_deref(), Some("登录后可下载"));
        let four_k = matrix.hints.iter().find(|hint| hint.qn == 120).unwrap();
        assert_eq!(four_k.reason.as_deref(), Some("大会员专享"));
        assert_eq!(matrix.audio_size, Some(134695 * 2055 / 8));
        let sd = matrix.hints.iter().find(|hint| hint.qn == 32).unwrap();
        assert!(sd.size_bytes.unwrap() > 0);
    }

    #[test]
    fn detects_risk_control_codes() {
        assert!(is_risk_code(-352));
        assert!(is_risk_code(-412));
        assert!(is_risk_code(-799));
        assert!(!is_risk_code(-101));
        assert!(!is_risk_code(0));
        assert!(is_risk_control_body(&serde_json::json!({"code": -352})));
        assert!(!is_risk_control_body(&serde_json::json!({"code": 0})));
        assert!(!is_risk_control_body(&serde_json::json!({})));
    }

    #[test]
    fn only_retries_server_errors() {
        assert!(is_retryable(&MetaError::Remote("HTTP 502".into())));
        assert!(!is_retryable(&MetaError::Remote("HTTP 404".into())));
        assert!(!is_retryable(&MetaError::RiskControl("HTTP 412".into())));
        assert!(!is_retryable(&MetaError::Network("timed out".into())));
        assert!(MetaError::RiskControl("-352".into()).is_risk_control());
    }

    #[test]
    fn caches_mixin_key_until_ttl_expires() {
        let mut cache = MixinKeyCache { entry: None };
        assert!(cache.read(MIXIN_KEY_TTL).is_none());
        cache.write("abcdef");
        assert_eq!(cache.read(MIXIN_KEY_TTL).as_deref(), Some("abcdef"));
        // 超过 TTL 后必须重新获取。
        cache.entry = Some(CachedMixinKey {
            key: "stale".into(),
            fetched_at: Instant::now() - MIXIN_KEY_TTL - Duration::from_secs(1),
        });
        assert!(cache.read(MIXIN_KEY_TTL).is_none());
        cache.clear();
        assert!(cache.entry.is_none());
    }

    fn playurl_fixture_missing_4k() -> Value {
        serde_json::json!({
            "code": 0,
            "data": {
                "quality": 80,
                "accept_quality": [80, 64, 32],
                "accept_description": ["1080P", "720P", "480P"],
                // support_formats 漏掉 4K，但 dash 里确实返回了 120。
                "support_formats": [
                    {"quality": 80, "display_desc": "1080P"},
                    {"quality": 64, "display_desc": "720P"},
                    {"quality": 32, "display_desc": "480P"}
                ],
                "dash": {
                    "video": [
                        {"id": 120, "baseUrl": "https://example.invalid/4k", "bandwidth": 1000000, "codecs": "avc1.640033", "width": 3840, "height": 2160, "frameRate": "60/1"},
                        {"id": 80, "baseUrl": "https://example.invalid/1080", "bandwidth": 400000, "codecs": "avc1.64001F", "width": 1920, "height": 1080, "frameRate": "30/1"}
                    ],
                    "audio": [{"id": 30232, "bandwidth": 134695, "codecs": "mp4a.40.2"}]
                }
            }
        })
    }

    #[test]
    fn backfills_missing_tiers_from_dash_video() {
        let matrix = fixture(playurl_fixture_missing_4k());
        assert_eq!(matrix.hints.len(), 4);
        let four_k = matrix
            .hints
            .iter()
            .find(|hint| hint.qn == 120)
            .expect("support_formats 漏档也要从 dash 补回来");
        assert_eq!(four_k.label, "4K");
        assert_eq!(four_k.height, 2160);
        assert!(four_k.accessible);
        assert!(four_k.size_bytes.unwrap() > 0);
        assert_eq!(four_k.codec.as_deref(), Some("avc1.640033"));
    }

    #[test]
    fn unknown_qn_uses_dash_height_and_keeps_label() {
        let value = serde_json::json!({
            "code": 0,
            "data": {
                "quality": 130,
                "support_formats": [],
                "dash": {
                    "video": [
                        {"id": 130, "baseUrl": "https://example.invalid/new", "bandwidth": 2000000, "codecs": "avc1", "height": 2160, "frameRate": "60/1"}
                    ]
                }
            }
        });
        let matrix = fixture(value);
        assert_eq!(matrix.hints.len(), 1);
        let hint = &matrix.hints[0];
        assert_eq!(hint.qn, 130);
        // 未知 qn 不再退化成 "QN 130"，按真实高度派生可读名。
        assert_eq!(hint.label, "4K");
        assert_eq!(hint.height, 2160);
        assert!(hint.fps >= 59.0);
        assert!(hint.accessible);
    }

    #[test]
    fn derived_label_does_not_collide_with_known_tier() {
        let value = serde_json::json!({
            "code": 0,
            "data": {
                "quality": 120,
                "support_formats": [{"quality": 120, "display_desc": "4K"}],
                "dash": {
                    "video": [
                        {"id": 130, "baseUrl": "https://example.invalid/unknown", "bandwidth": 2000000, "codecs": "avc1", "height": 2160},
                        {"id": 120, "baseUrl": "https://example.invalid/4k", "bandwidth": 1000000, "codecs": "avc1", "height": 2160}
                    ]
                }
            }
        });
        let matrix = fixture(value);
        let known = matrix.hints.iter().find(|hint| hint.qn == 120).unwrap();
        let unknown = matrix.hints.iter().find(|hint| hint.qn == 130).unwrap();
        assert_eq!(known.label, "4K");
        // 派生名撞上已知档时要加后缀，否则按 label 去重会把新档吞掉。
        assert_eq!(unknown.label, "4K · QN130");
        assert_ne!(known.label, unknown.label);
    }

    #[test]
    fn backup_url_counts_as_accessible() {
        let value = serde_json::json!({
            "code": 0,
            "data": {
                "quality": 0,
                "dash": {
                    "video": [
                        {"id": 64, "backupUrl": ["https://example.invalid/backup"], "bandwidth": 300000, "codecs": "avc1", "height": 720}
                    ]
                }
            }
        });
        let matrix = fixture(value);
        let hint = matrix.hints.iter().find(|hint| hint.qn == 64).unwrap();
        assert!(hint.accessible, "只有备份地址也应视为可下载");
    }

    #[test]
    fn dash_only_response_no_longer_errors() {
        // 没有 support_formats、没有 accept_quality，只有 dash：过去会直接报错。
        let value = serde_json::json!({
            "code": 0,
            "data": {
                "quality": 0,
                "dash": {
                    "video": [
                        {"id": 32, "baseUrl": "https://example.invalid/480", "bandwidth": 155817, "codecs": "avc1", "height": 480}
                    ]
                }
            }
        });
        let matrix = fixture(value);
        assert_eq!(matrix.hints.len(), 1);
        assert_eq!(matrix.hints[0].qn, 32);
        assert_eq!(matrix.hints[0].label, "480P");
    }

    #[test]
    fn maps_quality_labels_and_format_ids() {
        assert_eq!(quality_label(116, ""), "1080P60");
        assert_eq!(quality_label(112, "1080P"), "1080P+");
        assert_eq!(quality_label(126, ""), "杜比视界");
        assert_eq!(quality_height(32), 480);
        assert_eq!(quality_fps(74), 60.0);
        assert_eq!(qn_from_format_id("30080"), Some(80));
        assert_eq!(qn_from_format_id("30032"), Some(32));
        assert_eq!(qn_from_format_id("30232"), None);
        assert_eq!(
            normalize_bvid("BV1C8xn6YEDA_p1").as_deref(),
            Some("BV1C8xn6YEDA")
        );
        assert_eq!(
            normalize_bvid("https://www.bilibili.com/video/BV1xx411c7mD?p=2").as_deref(),
            Some("BV1xx411c7mD")
        );
        assert!(normalize_bvid("av12345").is_none());
    }

    fn probe_with_480() -> VideoProbe {
        VideoProbe {
            pages: Vec::new(),
            audio_tracks: Vec::new(),
            season: None,
            source_url: "https://www.bilibili.com/video/BV1xx411c7mD".into(),
            bvid: Some("BV1xx411c7mD".into()),
            title: "test".into(),
            uploader: "up".into(),
            cover_url: None,
            cover_path: None,
            duration_seconds: Some(2055),
            view_count: None,
            api_danmaku_count: None,
            published_at: None,
            description: None,
            qualities: vec![
                QualityOption {
                    format_id: "30032".into(),
                    audio_format_id: Some("30232".into()),
                    label: "384P".into(),
                    resolution: Some("512x384".into()),
                    width: Some(512),
                    height: Some(384),
                    fps: Some(15.0),
                    codec: "avc1.64001E".into(),
                    container: "mp4".into(),
                    size_bytes: Some(74_600_000),
                    audio_only: false,
                    dynamic_range: None,
                    note: None,
                    accessible: true,
                    reason: None,
                },
                QualityOption {
                    format_id: "30016".into(),
                    audio_format_id: Some("30232".into()),
                    label: "360P".into(),
                    resolution: Some("480x360".into()),
                    width: Some(480),
                    height: Some(360),
                    fps: Some(15.0),
                    codec: "avc1.64001E".into(),
                    container: "mp4".into(),
                    size_bytes: Some(50_000_000),
                    audio_only: false,
                    dynamic_range: None,
                    note: None,
                    accessible: true,
                    reason: None,
                },
                QualityOption {
                    format_id: "30232".into(),
                    audio_format_id: None,
                    label: "仅音频".into(),
                    resolution: None,
                    width: None,
                    height: None,
                    fps: None,
                    codec: "mp4a.40.2".into(),
                    container: "mp3".into(),
                    size_bytes: Some(34_600_000),
                    audio_only: true,
                    dynamic_range: None,
                    note: None,
                    accessible: true,
                    reason: None,
                },
            ],
            subtitles: Vec::<SubtitleTrack>::new(),
            danmaku: DanmakuInfo {
                available: false,
                count: None,
                counts: BTreeMap::new(),
                url: None,
                reason: None,
            },
            recommended_quality: Some("30032".into()),
            engine_version: "test".into(),
            warnings: vec![],
        }
    }

    #[test]
    fn merges_api_matrix_with_ytdlp_formats() {
        let matrix = fixture(playurl_fixture());
        let mut probe = probe_with_480();
        apply_quality_matrix(&mut probe, &matrix);
        let labels = probe
            .qualities
            .iter()
            .map(|quality| quality.label.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            labels,
            vec![
                "HDR",
                "4K",
                "1080P60",
                "1080P",
                "720P",
                "480P",
                "360P",
                "仅音频"
            ]
        );
        let sd = probe
            .qualities
            .iter()
            .find(|quality| quality.label == "480P")
            .unwrap();
        assert_eq!(sd.format_id, "30032");
        assert!(sd.accessible);
        assert!(sd.size_bytes.unwrap() > 0);
        let hd = probe
            .qualities
            .iter()
            .find(|quality| quality.label == "1080P")
            .unwrap();
        assert!(!hd.accessible);
        assert_eq!(hd.reason.as_deref(), Some("登录后可下载"));
        assert_eq!(probe.recommended_quality.as_deref(), Some("30032"));
        assert_eq!(
            probe.qualities.last().map(|quality| quality.label.as_str()),
            Some("仅音频")
        );
    }

    #[test]
    fn lower_tier_claims_shared_stream_before_high_bitrate_tier() {
        let value = serde_json::json!({
            "code": 0,
            "data": {
                "quality": 32,
                "support_formats": [
                    {"quality": 112, "display_desc": "1080P+"},
                    {"quality": 80, "display_desc": "1080P"}
                ],
                "dash": {
                    "video": [
                        {"id": 80, "baseUrl": "https://example.invalid/1080", "bandwidth": 1000, "codecs": "avc1.640028", "width": 1920, "height": 1080}
                    ],
                    "audio": []
                }
            }
        });
        let matrix = build_matrix(&value, Some(60)).unwrap();
        assert_eq!(matrix.hints.first().map(|hint| hint.qn), Some(112));

        let mut probe = probe_with_480();
        let mut video = probe.qualities[0].clone();
        video.format_id = "999".into();
        video.label = "1080P".into();
        video.width = Some(1920);
        video.height = Some(1080);
        video.fps = Some(30.0);
        video.accessible = true;
        probe.qualities.retain(|quality| quality.audio_only);
        probe.qualities.insert(0, video);

        apply_quality_matrix(&mut probe, &matrix);
        let base = probe
            .qualities
            .iter()
            .find(|quality| quality.label == "1080P")
            .unwrap();
        let plus = probe
            .qualities
            .iter()
            .find(|quality| quality.label == "1080P+")
            .unwrap();
        assert!(base.accessible);
        assert_eq!(base.format_id, "999");
        assert!(!plus.accessible);
        assert!(plus
            .reason
            .as_deref()
            .unwrap_or_default()
            .contains("大会员"));
    }

    #[test]
    #[ignore = "requires network access to Bilibili"]
    fn fetches_real_quality_matrix() {
        let matrix = fetch_quality_matrix("BV1C8xn6YEDA", None).expect("matrix");
        assert!(matrix.hints.len() >= 5);
        assert!(matrix.hints.iter().any(|hint| !hint.accessible));
        assert!(matrix.hints.iter().any(|hint| hint.qn == 120));
        assert!(matrix.audio_size.is_some());
    }

    #[test]
    fn signs_wbi_query_deterministically() {
        let mut params = BTreeMap::new();
        params.insert("bvid".into(), "BV1xx411c7mD".into());
        params.insert("wts".into(), "1700000000".into());
        let first = signed_query(&params, "0123456789abcdef0123456789abcdef");
        let second = signed_query(&params, "0123456789abcdef0123456789abcdef");
        assert_eq!(first, second);
        assert!(first.contains("w_rid="));
        assert_eq!(first.split("w_rid=").nth(1).unwrap().len(), 32);
    }
}
