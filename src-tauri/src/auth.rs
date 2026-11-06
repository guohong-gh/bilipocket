use std::{path::PathBuf, sync::Mutex, time::Duration};

use reqwest::{
    blocking::Client,
    header::{COOKIE, REFERER, SET_COOKIE, USER_AGENT},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::domain::{now_ms, AccountInfo, AuthStatus, QrLoginPoll, QrLoginStart};
use crate::util::LockExt;

const KEYRING_SERVICE: &str = "BiliPocket";
const KEYRING_USER: &str = "bilibili-session";
const USER_AGENT_VALUE: &str = "BiliPocket/0.7 (+local desktop client)";
const NAV_URL: &str = "https://api.bilibili.com/x/web-interface/nav";
const QR_GENERATE_URL: &str =
    "https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header";
const QR_POLL_URL: &str = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("network error: {0}")]
    Network(String),
    #[error("Bilibili returned an error: {0}")]
    Remote(String),
    #[error("login state is invalid or expired")]
    InvalidSession,
    #[error("secure storage error: {0}")]
    SecureStorage(String),
    #[error("QR code error: {0}")]
    Qr(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    secure: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSession {
    account: AccountInfo,
    cookies: Vec<StoredCookie>,
}

#[derive(Debug, Clone)]
enum SessionBackend {
    Keyring,
    PortableFile(PathBuf),
}

impl SessionBackend {
    fn load(&self) -> Result<Option<StoredSession>, AuthError> {
        match self {
            Self::Keyring => load_keyring_session(),
            Self::PortableFile(path) => load_portable_session(path),
        }
    }

    fn save(&self, session: &StoredSession) -> Result<(), AuthError> {
        match self {
            Self::Keyring => save_keyring_session(session),
            Self::PortableFile(path) => save_portable_session(path, session),
        }
    }

    fn clear(&self) -> Result<(), AuthError> {
        match self {
            Self::Keyring => clear_keyring_session(),
            Self::PortableFile(path) => match std::fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(AuthError::SecureStorage(format!(
                    "无法删除便携会话：{error}"
                ))),
            },
        }
    }
}

pub struct AuthManager {
    session: Mutex<Option<StoredSession>>,
    backend: SessionBackend,
}

impl AuthManager {
    pub fn new(data_dir: &std::path::Path, portable: bool) -> Self {
        let backend = if portable {
            SessionBackend::PortableFile(data_dir.join("session.dpapi"))
        } else {
            SessionBackend::Keyring
        };
        let session = backend.load().unwrap_or_else(|error| {
            log::warn!("读取登录凭据失败：{error}");
            None
        });
        // 早期版本可能把不完整的会话写进凭据库，这里在启动时清掉，避免"看起来已登录但下载是匿名"。
        let session = match session {
            Some(session) if validate_session(&session.cookies).is_err() => {
                log::info!("本地登录凭据不完整，已清除");
                if let Err(error) = backend.clear() {
                    log::warn!("清除登录凭据失败：{error}");
                }
                None
            }
            other => other,
        };
        Self {
            session: Mutex::new(session),
            backend,
        }
    }

    pub fn status(&self) -> AuthStatus {
        let session = self.session.lock_or_recover("auth");
        AuthStatus {
            logged_in: session.is_some(),
            account: session.as_ref().map(|session| session.account.clone()),
        }
    }

    pub fn validate(&self) -> AuthStatus {
        let Some(cookie_header) = self.cookie_header() else {
            return self.status();
        };
        match fetch_account_with_header(&cookie_header) {
            Ok(account) => {
                let mut session = self.session.lock_or_recover("auth");
                if let Some(stored) = session.as_mut() {
                    stored.account = account;
                    if let Err(error) = self.backend.save(stored) {
                        log::warn!("无法更新登录状态：{error}");
                    }
                }
                drop(session);
                self.status()
            }
            Err(AuthError::InvalidSession) => {
                log::info!("Bilibili 会话已过期，已清除本地凭据");
                let _ = self.logout();
                self.status()
            }
            Err(error) => {
                log::warn!("无法校验登录状态：{error}");
                self.status()
            }
        }
    }

    pub fn qr_start(&self) -> Result<QrLoginStart, AuthError> {
        let client = client()?;
        let response = browser_request(client.get(QR_GENERATE_URL))
            .send()
            .map_err(network_error)?;
        let body: Value = response.json().map_err(network_error)?;
        if body.get("code").and_then(Value::as_i64).unwrap_or(-1) != 0 {
            return Err(AuthError::Remote(format!(
                "生成二维码失败：{}",
                body.get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("未知错误")
            )));
        }
        let data = body
            .get("data")
            .ok_or_else(|| AuthError::Remote("二维码响应为空".into()))?;
        let qr_url = data
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| AuthError::Remote("二维码链接缺失".into()))?;
        let qrcode_key = data
            .get("qrcode_key")
            .and_then(Value::as_str)
            .ok_or_else(|| AuthError::Remote("二维码 key 缺失".into()))?
            .to_string();
        let code = qrcode::QrCode::new(qr_url.as_bytes())
            .map_err(|error| AuthError::Qr(error.to_string()))?;
        let svg = code
            .render::<qrcode::render::svg::Color>()
            .min_dimensions(220, 220)
            .quiet_zone(true)
            .build();

        Ok(QrLoginStart {
            qrcode_key,
            qr_svg: svg,
            expires_at: now_ms() + 180_000,
        })
    }

    pub fn qr_poll(&self, qrcode_key: &str) -> Result<QrLoginPoll, AuthError> {
        let client = client()?;
        let response = browser_request(
            client
                .get(QR_POLL_URL)
                .query(&[("qrcode_key", qrcode_key), ("source", "main-fe-header")]),
        )
        .send()
        .map_err(network_error)?;
        let headers = response.headers().clone();
        let body: Value = response.json().map_err(network_error)?;
        let data = body.get("data").unwrap_or(&Value::Null);
        let code = data.get("code").and_then(Value::as_i64).unwrap_or(-1);
        match code {
            0 => {
                let mut cookies = cookies_from_headers(&headers);
                if let Some(url) = data.get("url").and_then(Value::as_str) {
                    merge_url_cookies(&mut cookies, url);
                }
                if cookies.is_empty() {
                    return Err(AuthError::Remote("登录成功但未收到会话 Cookie".into()));
                }
                // 缺 SESSDATA 的会话既下不了会员档也读不到 nav，直接判失败而不是写进凭据库。
                validate_session(&cookies).map_err(|_| {
                    AuthError::Remote("登录成功但会话凭据不完整（缺少 SESSDATA），请重试".into())
                })?;
                let account = fetch_account(&cookies)?;
                let session = StoredSession {
                    account: account.clone(),
                    cookies,
                };
                if let Err(error) = self.backend.save(&session) {
                    log::warn!("无法保存登录凭据：{error}");
                }
                *self.session.lock_or_recover("auth") = Some(session);
                Ok(QrLoginPoll {
                    status: "success".into(),
                    message: None,
                    account: Some(account),
                })
            }
            86101 => Ok(QrLoginPoll {
                status: "waiting".into(),
                message: Some("请在哔哩哔哩 App 中扫码".into()),
                account: None,
            }),
            86090 => Ok(QrLoginPoll {
                status: "scanned".into(),
                message: Some("已扫码，请在手机上确认登录".into()),
                account: None,
            }),
            86038 => Ok(QrLoginPoll {
                status: "expired".into(),
                message: Some("二维码已过期，请刷新后重试".into()),
                account: None,
            }),
            _ => Ok(QrLoginPoll {
                status: "error".into(),
                message: Some(
                    data.get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("登录状态检查失败")
                        .to_string(),
                ),
                account: None,
            }),
        }
    }

    pub fn logout(&self) -> Result<AuthStatus, AuthError> {
        *self.session.lock_or_recover("auth") = None;
        self.backend.clear()?;
        Ok(self.status())
    }

    pub fn cookie_header(&self) -> Option<String> {
        let session = self.session.lock_or_recover("auth");
        let session = session.as_ref()?;
        if session.cookies.is_empty() {
            return None;
        }
        let header = cookie_header(&session.cookies).replace(['\r', '\n'], "");
        (!header.trim().is_empty()).then_some(header)
    }
}

fn client() -> Result<Client, AuthError> {
    Client::builder()
        .cookie_store(true)
        .timeout(Duration::from_secs(25))
        .user_agent(USER_AGENT_VALUE)
        .build()
        .map_err(network_error)
}

fn browser_request(
    builder: reqwest::blocking::RequestBuilder,
) -> reqwest::blocking::RequestBuilder {
    builder
        .header(USER_AGENT, USER_AGENT_VALUE)
        .header(REFERER, "https://www.bilibili.com/")
}

fn network_error(error: reqwest::Error) -> AuthError {
    AuthError::Network(error.to_string())
}

fn fetch_account(cookies: &[StoredCookie]) -> Result<AccountInfo, AuthError> {
    fetch_account_with_header(&cookie_header(cookies))
}

fn fetch_account_with_header(cookie_header: &str) -> Result<AccountInfo, AuthError> {
    let client = client()?;
    let response = browser_request(client.get(NAV_URL).header(COOKIE, cookie_header))
        .send()
        .map_err(network_error)?;
    let body: Value = response.json().map_err(network_error)?;
    parse_nav_value(&body)
}

fn parse_nav_value(body: &Value) -> Result<AccountInfo, AuthError> {
    let data = body.get("data").unwrap_or(&Value::Null);
    if data.get("isLogin").and_then(Value::as_bool) != Some(true) {
        return Err(AuthError::InvalidSession);
    }
    let vip = data.get("vipStatus").and_then(Value::as_i64).unwrap_or(0) > 0;
    Ok(AccountInfo {
        mid: data.get("mid").and_then(Value::as_u64).unwrap_or(0),
        name: data
            .get("uname")
            .and_then(Value::as_str)
            .unwrap_or("已登录")
            .to_string(),
        avatar_url: data.get("face").and_then(Value::as_str).map(str::to_string),
        vip,
    })
}

/// Cookie 值里不允许出现的字符（RFC 6265）。
/// 只处理这些，不要顺带编码 `/`、`=`、`:`——`bili_ticket`、`ac_time_value` 这类签名串会被破坏。
fn is_cookie_illegal(ch: char) -> bool {
    matches!(ch, ',' | ';' | ' ' | '"' | '\\') || (ch as u32) < 0x20 || ch == '\u{7f}'
}

/// 幂等：已含 `%` 的值视为已编码，不重复编码。
fn encode_cookie_value(value: &str) -> std::borrow::Cow<'_, str> {
    if !value.chars().any(is_cookie_illegal) {
        return std::borrow::Cow::Borrowed(value);
    }
    let mut encoded = String::with_capacity(value.len() + 8);
    for ch in value.chars() {
        if is_cookie_illegal(ch) {
            encoded.push_str(&format!("%{:02X}", ch as u32));
        } else {
            encoded.push(ch);
        }
    }
    std::borrow::Cow::Owned(encoded)
}

fn cookie_header(cookies: &[StoredCookie]) -> String {
    cookies
        .iter()
        .filter(|cookie| {
            let domain = cookie.domain.trim_start_matches('.');
            domain.ends_with("bilibili.com")
        })
        .map(|cookie| format!("{}={}", cookie.name, encode_cookie_value(&cookie.value)))
        .collect::<Vec<_>>()
        .join("; ")
}

fn cookies_from_headers(headers: &reqwest::header::HeaderMap) -> Vec<StoredCookie> {
    let mut cookies: Vec<StoredCookie> = Vec::new();
    for value in headers.get_all(SET_COOKIE) {
        let Ok(text) = value.to_str() else {
            continue;
        };
        let mut parts = text.split(';');
        let Some(pair) = parts.next() else {
            continue;
        };
        let Some((name, value)) = pair.split_once('=') else {
            continue;
        };
        let mut domain = "bilibili.com".to_string();
        let mut path = "/".to_string();
        let mut secure = true;
        for attribute in parts {
            let attribute = attribute.trim();
            if let Some(value) = attribute
                .strip_prefix("Domain=")
                .or_else(|| attribute.strip_prefix("domain="))
            {
                domain = value.trim().to_string();
            } else if let Some(value) = attribute
                .strip_prefix("Path=")
                .or_else(|| attribute.strip_prefix("path="))
            {
                path = value.trim().to_string();
            } else if attribute.eq_ignore_ascii_case("secure") {
                secure = true;
            }
        }
        push_cookie(
            &mut cookies,
            name.trim(),
            value.trim(),
            &domain,
            &path,
            secure,
        );
    }
    cookies
}

fn merge_url_cookies(cookies: &mut Vec<StoredCookie>, url: &str) {
    let Ok(parsed) = url::Url::parse(url) else {
        return;
    };
    let Some(query) = parsed.query() else {
        return;
    };
    // 这里刻意不用 query_pairs()：它会把 %2C 解码成逗号，而 SESSDATA 真实值就是
    // `abc%2C123%2Cxyz` 这种形式，解码后再拼进 Cookie 头会被服务端当成多段而截断。
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if value.is_empty() {
            continue;
        }
        if matches!(
            name,
            "SESSDATA" | "bili_jct" | "DedeUserID" | "DedeUserID__ckMd5" | "sid" | "buvid3"
        ) {
            push_cookie(cookies, name, value, ".bilibili.com", "/", true);
        }
    }
}

fn push_cookie(
    cookies: &mut Vec<StoredCookie>,
    name: &str,
    value: &str,
    domain: &str,
    path: &str,
    secure: bool,
) {
    if name.is_empty() || name.contains([';', '=', ',', ' ', '\t', '\r', '\n']) {
        log::warn!("忽略非法的 Cookie 名：{name}");
        return;
    }
    // 空值/含分隔符的值会污染 Cookie 头（例如 `SESSDATA=; Max-Age=0` 这类删除指令），直接丢弃。
    if value.is_empty() || value.contains(['\r', '\n', ';']) {
        log::warn!("忽略非法的 Cookie 值：{name}");
        return;
    }
    if let Some(existing) = cookies.iter_mut().find(|cookie| cookie.name == name) {
        existing.value = value.to_string();
        existing.domain = domain.to_string();
        existing.path = path.to_string();
        existing.secure = secure;
        return;
    }
    cookies.push(StoredCookie {
        name: name.to_string(),
        value: value.to_string(),
        domain: domain.to_string(),
        path: path.to_string(),
        secure,
    });
}

/// 只把 SESSDATA 当硬门槛：nav 只认它。
/// `bili_jct` / `DedeUserID` 缺失只可能影响写操作，拿它们当门槛会误杀合法会话。
fn validate_session(cookies: &[StoredCookie]) -> Result<(), AuthError> {
    let has_sessdata = cookies
        .iter()
        .any(|cookie| cookie.name == "SESSDATA" && !cookie.value.is_empty());
    if !has_sessdata {
        return Err(AuthError::InvalidSession);
    }
    if !cookies.iter().any(|cookie| cookie.name == "bili_jct") {
        log::warn!("会话缺少 bili_jct，部分写操作可能受限");
    }
    Ok(())
}

fn keyring_entry() -> Result<keyring::Entry, AuthError> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|error| AuthError::SecureStorage(error.to_string()))
}

fn load_keyring_session() -> Result<Option<StoredSession>, AuthError> {
    let entry = keyring_entry()?;
    match entry.get_password() {
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|error| AuthError::SecureStorage(error.to_string())),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(AuthError::SecureStorage(error.to_string())),
    }
}

fn save_keyring_session(session: &StoredSession) -> Result<(), AuthError> {
    let entry = keyring_entry()?;
    let raw = serde_json::to_string(session)
        .map_err(|error| AuthError::SecureStorage(error.to_string()))?;
    entry
        .set_password(&raw)
        .map_err(|error| AuthError::SecureStorage(error.to_string()))
}

fn clear_keyring_session() -> Result<(), AuthError> {
    let entry = keyring_entry()?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(AuthError::SecureStorage(error.to_string())),
    }
}

fn load_portable_session(path: &std::path::Path) -> Result<Option<StoredSession>, AuthError> {
    let encrypted = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(AuthError::SecureStorage(format!(
                "无法读取便携会话：{error}"
            )))
        }
    };
    let raw = dpapi_unprotect(&encrypted)?;
    serde_json::from_slice(&raw)
        .map(Some)
        .map_err(|error| AuthError::SecureStorage(error.to_string()))
}

fn save_portable_session(path: &std::path::Path, session: &StoredSession) -> Result<(), AuthError> {
    let raw =
        serde_json::to_vec(session).map_err(|error| AuthError::SecureStorage(error.to_string()))?;
    let encrypted = dpapi_protect(&raw)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| AuthError::SecureStorage(format!("无法创建便携会话目录：{error}")))?;
    }
    let temporary = path.with_extension("dpapi.tmp");
    std::fs::write(&temporary, encrypted)
        .map_err(|error| AuthError::SecureStorage(format!("无法写入便携会话：{error}")))?;
    let _ = std::fs::remove_file(path);
    std::fs::rename(&temporary, path)
        .map_err(|error| AuthError::SecureStorage(format!("无法保存便携会话：{error}")))
}

#[cfg(windows)]
fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, AuthError> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    if data.len() > u32::MAX as usize {
        return Err(AuthError::SecureStorage("登录数据过大。".into()));
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    }
    .map_err(|error| AuthError::SecureStorage(format!("DPAPI 加密失败：{error}")))?;
    let encrypted =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
    }
    Ok(encrypted)
}

#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, AuthError> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    if data.len() > u32::MAX as usize {
        return Err(AuthError::SecureStorage("会话数据过大。".into()));
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    }
    .map_err(|error| AuthError::SecureStorage(format!("DPAPI 解密失败：{error}")))?;
    let decrypted =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
    }
    Ok(decrypted)
}

#[cfg(not(windows))]
fn dpapi_protect(_data: &[u8]) -> Result<Vec<u8>, AuthError> {
    Err(AuthError::SecureStorage("便携会话仅支持 Windows。".into()))
}

#[cfg(not(windows))]
fn dpapi_unprotect(_data: &[u8]) -> Result<Vec<u8>, AuthError> {
    Err(AuthError::SecureStorage("便携会话仅支持 Windows。".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trips_portable_session_bytes() {
        let payload = b"{\"account\":\"portable-test\"}";
        let encrypted = dpapi_protect(payload).unwrap();
        assert_ne!(encrypted.as_slice(), payload);
        assert_eq!(dpapi_unprotect(&encrypted).unwrap(), payload);
    }

    #[cfg(windows)]
    #[test]
    fn portable_session_round_trip_stays_in_app_data() {
        let directory = std::env::temp_dir().join(format!("bilipocket_session_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("session.dpapi");
        let backend = SessionBackend::PortableFile(path.clone());
        let session = StoredSession {
            account: AccountInfo {
                mid: 1,
                name: "便携测试".into(),
                avatar_url: None,
                vip: false,
            },
            cookies: vec![StoredCookie {
                name: "SESSDATA".into(),
                value: "test".into(),
                domain: ".bilibili.com".into(),
                path: "/".into(),
                secure: true,
            }],
        };
        backend.save(&session).unwrap();
        assert!(path.is_file());
        let loaded = backend.load().unwrap().unwrap();
        assert_eq!(loaded.account.name, "便携测试");
        assert_eq!(loaded.cookies.len(), 1);
        backend.clear().unwrap();
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn parses_set_cookie_headers() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.append(
            SET_COOKIE,
            reqwest::header::HeaderValue::from_static(
                "SESSDATA=abc%2C123; Domain=.bilibili.com; Path=/; Secure; HttpOnly",
            ),
        );
        let cookies = cookies_from_headers(&headers);
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].name, "SESSDATA");
        assert_eq!(cookies[0].domain, ".bilibili.com");
        assert!(cookies[0].secure);
    }

    #[test]
    fn merges_cookies_from_login_redirect() {
        let mut cookies = Vec::new();
        merge_url_cookies(
            &mut cookies,
            "https://passport.biligame.com/crossDomain?SESSDATA=token&bili_jct=csrf&DedeUserID=42",
        );
        assert_eq!(cookies.len(), 3);
        assert!(cookies
            .iter()
            .any(|cookie| cookie.name == "DedeUserID" && cookie.value == "42"));
    }

    #[test]
    fn merge_keeps_percent_encoded_values() {
        let mut cookies = Vec::new();
        merge_url_cookies(
            &mut cookies,
            "https://passport.bilibili.com/x?SESSDATA=abc%2C123%2Cxyz&bili_jct=csrf",
        );
        let sessdata = cookies
            .iter()
            .find(|cookie| cookie.name == "SESSDATA")
            .expect("SESSDATA 应被保留");
        // 必须是原文，而不是解码后的 abc,123,xyz。
        assert_eq!(sessdata.value, "abc%2C123%2Cxyz");
        assert_eq!(
            cookie_header(&cookies),
            "SESSDATA=abc%2C123%2Cxyz; bili_jct=csrf"
        );
    }

    #[test]
    fn merge_skips_empty_values() {
        let mut cookies = Vec::new();
        push_cookie(&mut cookies, "SESSDATA", "keep", ".bilibili.com", "/", true);
        merge_url_cookies(
            &mut cookies,
            "https://passport.bilibili.com/x?SESSDATA=&bili_jct=csrf",
        );
        let sessdata = cookies
            .iter()
            .find(|cookie| cookie.name == "SESSDATA")
            .unwrap();
        // 空值不得把已有凭据覆盖掉。
        assert_eq!(sessdata.value, "keep");
    }

    #[test]
    fn cookie_header_encodes_legacy_decoded_value() {
        let cookies = vec![StoredCookie {
            name: "SESSDATA".into(),
            value: "abc,123,xyz".into(),
            domain: ".bilibili.com".into(),
            path: "/".into(),
            secure: true,
        }];
        assert_eq!(cookie_header(&cookies), "SESSDATA=abc%2C123%2Cxyz");
    }

    #[test]
    fn cookie_header_is_idempotent_and_keeps_signature_chars() {
        let encoded = vec![StoredCookie {
            name: "SESSDATA".into(),
            value: "abc%2C123%2Cxyz".into(),
            domain: ".bilibili.com".into(),
            path: "/".into(),
            secure: true,
        }];
        assert_eq!(cookie_header(&encoded), "SESSDATA=abc%2C123%2Cxyz");

        // `/`、`=`、`:` 是签名串的合法字符，不能被编码。
        let signature = vec![StoredCookie {
            name: "bili_ticket".into(),
            value: "eyJhbGciOiJIUzI1NiJ9.c2ln/x==".into(),
            domain: ".bilibili.com".into(),
            path: "/".into(),
            secure: true,
        }];
        assert_eq!(
            cookie_header(&signature),
            "bili_ticket=eyJhbGciOiJIUzI1NiJ9.c2ln/x=="
        );
    }

    #[test]
    fn push_cookie_rejects_control_chars_and_empty_values() {
        let mut cookies = Vec::new();
        push_cookie(&mut cookies, "SESSDATA", "ok", ".bilibili.com", "/", true);
        push_cookie(
            &mut cookies,
            "SESSDATA",
            "bad\r\ninjected",
            ".bilibili.com",
            "/",
            true,
        );
        push_cookie(&mut cookies, "SESSDATA", "", ".bilibili.com", "/", true);
        push_cookie(&mut cookies, "bad name", "v", ".bilibili.com", "/", true);

        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].value, "ok");
    }

    #[test]
    fn session_without_sessdata_is_rejected() {
        let only_jct = vec![StoredCookie {
            name: "bili_jct".into(),
            value: "csrf".into(),
            domain: ".bilibili.com".into(),
            path: "/".into(),
            secure: true,
        }];
        assert!(matches!(
            validate_session(&only_jct),
            Err(AuthError::InvalidSession)
        ));

        let full = vec![
            StoredCookie {
                name: "SESSDATA".into(),
                value: "abc".into(),
                domain: ".bilibili.com".into(),
                path: "/".into(),
                secure: true,
            },
            StoredCookie {
                name: "bili_jct".into(),
                value: "csrf".into(),
                domain: ".bilibili.com".into(),
                path: "/".into(),
                secure: true,
            },
        ];
        assert!(validate_session(&full).is_ok());

        // 只有 SESSDATA 也是合法会话（nav 只认它）。
        assert!(validate_session(&full[..1]).is_ok());
    }

    #[test]
    fn parses_logged_in_and_expired_nav() {
        let logged_in = serde_json::json!({
            "code": 0,
            "data": {"isLogin": true, "mid": 42, "uname": "tester", "vipStatus": 1, "face": "https://example.invalid/a.jpg"}
        });
        let account = parse_nav_value(&logged_in).unwrap();
        assert_eq!(account.mid, 42);
        assert_eq!(account.name, "tester");
        assert!(account.vip);

        let guest = serde_json::json!({"code": -101, "data": {"isLogin": false}});
        assert!(matches!(
            parse_nav_value(&guest),
            Err(AuthError::InvalidSession)
        ));
    }
}
