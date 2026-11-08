use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};

use rusqlite::{params, Connection, OptionalExtension, Row};
use thiserror::Error;

use crate::domain::{HistoryEntry, Settings, Task, TaskKind, TaskOptions, TaskStatus};
use crate::util::LockExt;

const SETTINGS_KEY: &str = "settings";
/// 设置 JSON 结构损坏时的原文备份键（不会被任何读取路径查询）。
const BROKEN_SETTINGS_KEY: &str = "settings.broken";
const HISTORY_LIMIT: i64 = 100;

const TASK_COLUMNS: &str = "id, source_url, bvid, title, uploader, cover_url, duration_seconds,
                    format_id, quality_label, container, size_bytes, downloaded_bytes,
                    speed_bytes_per_sec, eta_seconds, status, error_code, error_message,
                    output_path, temp_dir, danmaku_types_json, subtitle_langs_json,
                    engine_version, attempt, created_at, queued_at, started_at, completed_at,
                    danmaku_count, cover_path, retry_at, kind, extras_error, options_json";

#[derive(Debug, Error)]
pub enum DbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

fn insert_task_row(conn: &Connection, task: &Task) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO tasks (
            id, source_url, bvid, title, uploader, cover_url, duration_seconds,
            format_id, quality_label, container, size_bytes, downloaded_bytes,
            speed_bytes_per_sec, eta_seconds, status, error_code, error_message,
            output_path, temp_dir, danmaku_types_json, subtitle_langs_json,
            engine_version, attempt, created_at, queued_at, started_at, completed_at,
            danmaku_count, cover_path, retry_at, kind, extras_error, options_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                   ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30,
                   ?31, ?32, ?33)",
        params![
            task.id,
            task.source_url,
            task.bvid,
            task.title,
            task.uploader,
            task.cover_url,
            opt_u64_to_i64(task.duration_seconds),
            task.format_id,
            task.quality_label,
            task.container,
            opt_u64_to_i64(task.size_bytes),
            task.downloaded_bytes.min(i64::MAX as u64) as i64,
            task.speed_bytes_per_sec,
            opt_u64_to_i64(task.eta_seconds),
            task.status.as_str(),
            task.error_code,
            task.error_message,
            task.output_path,
            task.temp_dir,
            serde_json::to_string(&task.danmaku_types)?,
            serde_json::to_string(&task.subtitle_langs)?,
            task.engine_version,
            task.attempt,
            task.created_at,
            task.queued_at,
            task.started_at,
            task.completed_at,
            task.danmaku_count.min(i64::MAX as u64) as i64,
            task.cover_path,
            task.retry_at,
            task.kind.as_str(),
            task.extras_error,
            serde_json::to_string(&task.options)?,
        ],
    )?;
    Ok(())
}

fn update_task_row(
    conn: &Connection,
    task: &Task,
    expected: Option<TaskStatus>,
) -> Result<usize, DbError> {
    Ok(conn.execute(
        "UPDATE tasks SET
            bvid = ?2, title = ?3, uploader = ?4, cover_url = ?5, duration_seconds = ?6,
            size_bytes = ?7, downloaded_bytes = ?8, speed_bytes_per_sec = ?9,
            eta_seconds = ?10, status = ?11, error_code = ?12, error_message = ?13,
            output_path = ?14, temp_dir = ?15, danmaku_types_json = ?16,
            subtitle_langs_json = ?17, engine_version = ?18, attempt = ?19,
            queued_at = ?20, started_at = ?21, completed_at = ?22, danmaku_count = ?23,
            cover_path = ?24, retry_at = ?25, extras_error = ?26, options_json = ?28
         WHERE id = ?1 AND (?27 IS NULL OR status = ?27)",
        params![
            task.id,
            task.bvid,
            task.title,
            task.uploader,
            task.cover_url,
            opt_u64_to_i64(task.duration_seconds),
            opt_u64_to_i64(task.size_bytes),
            task.downloaded_bytes.min(i64::MAX as u64) as i64,
            task.speed_bytes_per_sec,
            opt_u64_to_i64(task.eta_seconds),
            task.status.as_str(),
            task.error_code,
            task.error_message,
            task.output_path,
            task.temp_dir,
            serde_json::to_string(&task.danmaku_types)?,
            serde_json::to_string(&task.subtitle_langs)?,
            task.engine_version,
            task.attempt,
            task.queued_at,
            task.started_at,
            task.completed_at,
            task.danmaku_count.min(i64::MAX as u64) as i64,
            task.cover_path,
            task.retry_at,
            task.extras_error,
            expected.map(TaskStatus::as_str),
            serde_json::to_string(&task.options)?,
        ],
    )?)
}

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, DbError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if (1..6).contains(&version) {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
            let backup = path.with_extension(format!("db.bak-v{version}"));
            match std::fs::copy(path, &backup) {
                Ok(_) => log::info!("数据库升级前备份：{}", backup.display()),
                Err(error) => log::warn!("数据库升级前备份失败：{error}"),
            }
        }
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, DbError> {
        let conn = Connection::open_in_memory()?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock_or_recover("db")
    }

    pub fn load_settings(&self, fallback_dir: &str) -> Result<Settings, DbError> {
        let conn = self.lock();
        let raw = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![SETTINGS_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        if let Some(raw) = raw {
            match serde_json::from_str::<Settings>(&raw) {
                Ok(mut settings) => {
                    settings.validate(fallback_dir);
                    return Ok(settings);
                }
                Err(error) => {
                    // 结构损坏（缺必填字段 / 类型不符）才会走到这里；取值越界由 validate 静默纠正。
                    // 只记录 serde 的描述，不记录 raw —— raw 含 downloadDir，诊断报告承诺不含路径。
                    log::warn!("设置 JSON 结构损坏，已回退默认值并把原文备份到 {BROKEN_SETTINGS_KEY}：{error}");
                    if let Err(backup_error) = conn.execute(
                        "INSERT INTO settings (key, value) VALUES (?1, ?2)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        params![BROKEN_SETTINGS_KEY, raw],
                    ) {
                        // 备份失败不能升级成「设置完全加载失败」，降级为告警。
                        log::warn!("无法备份损坏的设置原文：{backup_error}");
                    }
                }
            }
        }

        let settings = Settings::defaults(fallback_dir.to_string());
        drop(conn);
        self.save_settings(&settings)?;
        Ok(settings)
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<(), DbError> {
        let payload = serde_json::to_string(settings)?;
        let conn = self.lock();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![SETTINGS_KEY, payload],
        )?;
        Ok(())
    }

    pub fn list_tasks(&self) -> Result<Vec<Task>, DbError> {
        let conn = self.lock();
        let mut statement = conn.prepare(
            "SELECT id, source_url, bvid, title, uploader, cover_url, duration_seconds,
                    format_id, quality_label, container, size_bytes, downloaded_bytes,
                    speed_bytes_per_sec, eta_seconds, status, error_code, error_message,
                    output_path, temp_dir, danmaku_types_json, subtitle_langs_json,
                    engine_version, attempt, created_at, queued_at, started_at, completed_at,
                    danmaku_count, cover_path, retry_at, kind, extras_error, options_json
             FROM tasks ORDER BY created_at DESC",
        )?;
        let rows = statement.query_map([], task_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
    }

    pub fn get_task(&self, id: &str) -> Result<Option<Task>, DbError> {
        let conn = self.lock();
        task_by_id(&conn, id)
    }

    pub fn mark_task_paused(
        &self,
        id: &str,
        code: Option<&str>,
        message: Option<&str>,
    ) -> Result<Option<Task>, DbError> {
        let conn = self.lock();
        let changed = conn.execute(
            "UPDATE tasks SET status = 'paused', error_code = ?2, error_message = ?3,
                    speed_bytes_per_sec = 0, eta_seconds = NULL, retry_at = NULL
             WHERE id = ?1 AND status IN ('queued','probing','downloading','muxing','extras')",
            params![id, code, message],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        task_by_id(&conn, id)
    }

    #[cfg(test)]
    pub fn insert_task(&self, task: &Task) -> Result<(), DbError> {
        insert_task_row(&self.lock(), task)
    }

    pub fn insert_task_if_no_active_duplicate(&self, task: &Task) -> Result<bool, DbError> {
        let conn = self.lock();
        let tx = conn.unchecked_transaction()?;
        let duplicate = tx
            .query_row(
                "SELECT id FROM tasks
                 WHERE kind = ?2 AND format_id = ?3
                   AND status IN ('queued', 'probing', 'downloading', 'muxing', 'extras', 'paused', 'failed')
                   AND ((?1 IS NOT NULL AND bvid = ?1) OR (?1 IS NULL AND source_url = ?4))
                 LIMIT 1",
                params![
                    task.bvid,
                    task.kind.as_str(),
                    task.format_id,
                    task.source_url
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if duplicate.is_some() {
            return Ok(false);
        }
        insert_task_row(&tx, task)?;
        tx.commit()?;
        Ok(true)
    }

    pub fn update_task(&self, task: &Task) -> Result<(), DbError> {
        update_task_row(&self.lock(), task, None)?;
        Ok(())
    }

    pub fn update_task_if_status(
        &self,
        task: &Task,
        expected: TaskStatus,
    ) -> Result<bool, DbError> {
        Ok(update_task_row(&self.lock(), task, Some(expected))? == 1)
    }

    pub fn update_task_if_status_in(
        &self,
        task: &Task,
        expected: &[TaskStatus],
    ) -> Result<bool, DbError> {
        for status in expected {
            if self.update_task_if_status(task, *status)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn update_task_metadata_if_status(
        &self,
        task: &Task,
        expected: &[TaskStatus],
    ) -> Result<bool, DbError> {
        let conn = self.lock();
        for status in expected {
            let changed = conn.execute(
                "UPDATE tasks SET
                    bvid = ?2, title = ?3, uploader = ?4, cover_url = ?5, cover_path = ?6,
                    duration_seconds = ?7, quality_label = ?8, container = ?9,
                    size_bytes = ?10, engine_version = ?11, temp_dir = ?12
                 WHERE id = ?1 AND status = ?13",
                params![
                    task.id,
                    task.bvid,
                    task.title,
                    task.uploader,
                    task.cover_url,
                    task.cover_path,
                    opt_u64_to_i64(task.duration_seconds),
                    task.quality_label,
                    task.container,
                    opt_u64_to_i64(task.size_bytes),
                    task.engine_version,
                    task.temp_dir,
                    status.as_str(),
                ],
            )?;
            if changed == 1 {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn delete_task(&self, id: &str) -> Result<(), DbError> {
        self.lock()
            .execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn clear_completed(&self) -> Result<(), DbError> {
        self.lock()
            .execute("DELETE FROM tasks WHERE status = 'completed'", [])?;
        Ok(())
    }

    pub fn clear_all_tasks(&self) -> Result<(), DbError> {
        self.lock().execute("DELETE FROM tasks", [])?;
        Ok(())
    }

    pub fn recover_interrupted_tasks(&self) -> Result<usize, DbError> {
        let conn = self.lock();
        let changed = conn.execute(
            "UPDATE tasks
             SET status = 'paused',
                 error_code = 'interrupted',
                 error_message = '应用上次退出时任务未完成，可以继续下载。',
                 speed_bytes_per_sec = 0,
                 eta_seconds = NULL,
                 retry_at = NULL
             WHERE status IN ('probing', 'downloading', 'muxing', 'extras')",
            [],
        )?;
        Ok(changed)
    }

    pub fn insert_history(&self, entry: &HistoryEntry) -> Result<(), DbError> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO history (
                id, task_id, source_url, bvid, title, uploader, cover_url, duration_seconds,
                format_id, quality_label, container, size_bytes, output_path,
                danmaku_types_json, subtitle_langs_json, completed_at, danmaku_count,
                cover_path, kind, extras_error
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            params![
                entry.id,
                entry.task_id,
                entry.source_url,
                entry.bvid,
                entry.title,
                entry.uploader,
                entry.cover_url,
                opt_u64_to_i64(entry.duration_seconds),
                entry.format_id,
                entry.quality_label,
                entry.container,
                opt_u64_to_i64(entry.size_bytes),
                entry.output_path,
                serde_json::to_string(&entry.danmaku_types)?,
                serde_json::to_string(&entry.subtitle_langs)?,
                entry.completed_at,
                entry.danmaku_count.min(i64::MAX as u64) as i64,
                entry.cover_path,
                entry.kind.as_str(),
                entry.extras_error,
            ],
        )?;
        conn.execute(
            "DELETE FROM history WHERE id NOT IN (
                SELECT id FROM history ORDER BY completed_at DESC LIMIT ?1
             )",
            params![HISTORY_LIMIT],
        )?;
        Ok(())
    }

    pub fn list_history(&self) -> Result<Vec<HistoryEntry>, DbError> {
        let conn = self.lock();
        let mut statement = conn.prepare(
            "SELECT id, task_id, source_url, bvid, title, uploader, cover_url, duration_seconds,
                    format_id, quality_label, container, size_bytes, output_path,
                    danmaku_types_json, subtitle_langs_json, completed_at, danmaku_count,
                    cover_path, kind, extras_error
             FROM history ORDER BY completed_at DESC LIMIT ?1",
        )?;
        let rows = statement.query_map(params![HISTORY_LIMIT], history_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
    }

    pub fn get_history(&self, id: &str) -> Result<Option<HistoryEntry>, DbError> {
        self.lock()
            .query_row(
                "SELECT id, task_id, source_url, bvid, title, uploader, cover_url, duration_seconds,
                        format_id, quality_label, container, size_bytes, output_path,
                        danmaku_types_json, subtitle_langs_json, completed_at, danmaku_count,
                        cover_path, kind, extras_error
                 FROM history WHERE id = ?1",
                params![id],
                history_from_row,
            )
            .optional()
            .map_err(DbError::from)
    }

    pub fn delete_history(&self, id: &str) -> Result<(), DbError> {
        self.lock()
            .execute("DELETE FROM history WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn clear_history(&self) -> Result<(), DbError> {
        self.lock().execute("DELETE FROM history", [])?;
        Ok(())
    }
}

fn opt_u64_to_i64(value: Option<u64>) -> Option<i64> {
    value.map(|value| value.min(i64::MAX as u64) as i64)
}

fn opt_i64_to_u64(value: Option<i64>) -> Option<u64> {
    value.map(|value| value.max(0) as u64)
}

fn migrate(conn: &Connection) -> Result<(), DbError> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version < 1 {
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                source_url TEXT NOT NULL,
                bvid TEXT,
                title TEXT NOT NULL,
                uploader TEXT NOT NULL,
                cover_url TEXT,
                duration_seconds INTEGER,
                format_id TEXT NOT NULL,
                quality_label TEXT NOT NULL,
                container TEXT NOT NULL,
                size_bytes INTEGER,
                downloaded_bytes INTEGER NOT NULL DEFAULT 0,
                speed_bytes_per_sec REAL NOT NULL DEFAULT 0,
                eta_seconds INTEGER,
                status TEXT NOT NULL,
                error_code TEXT,
                error_message TEXT,
                output_path TEXT,
                temp_dir TEXT,
                danmaku_types_json TEXT NOT NULL DEFAULT '[]',
                subtitle_langs_json TEXT NOT NULL DEFAULT '[]',
                engine_version TEXT,
                attempt INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                queued_at INTEGER,
                started_at INTEGER,
                completed_at INTEGER
             );
             CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at DESC);
             CREATE TABLE IF NOT EXISTS history (
                id TEXT PRIMARY KEY,
                task_id TEXT,
                source_url TEXT NOT NULL,
                bvid TEXT,
                title TEXT NOT NULL,
                uploader TEXT NOT NULL,
                cover_url TEXT,
                duration_seconds INTEGER,
                format_id TEXT NOT NULL,
                quality_label TEXT NOT NULL,
                container TEXT NOT NULL,
                size_bytes INTEGER,
                output_path TEXT,
                danmaku_types_json TEXT NOT NULL DEFAULT '[]',
                subtitle_langs_json TEXT NOT NULL DEFAULT '[]',
                completed_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_history_completed ON history(completed_at DESC);
             PRAGMA user_version = 1;
             COMMIT;",
        )?;
    }
    let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if current < 2 {
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE tasks ADD COLUMN danmaku_count INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE history ADD COLUMN danmaku_count INTEGER NOT NULL DEFAULT 0;
             PRAGMA user_version = 2;
             COMMIT;",
        )?;
    }
    let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if current < 3 {
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE tasks ADD COLUMN cover_path TEXT;
             ALTER TABLE history ADD COLUMN cover_path TEXT;
             PRAGMA user_version = 3;
             COMMIT;",
        )?;
    }
    let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if current < 4 {
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE tasks ADD COLUMN retry_at INTEGER;
             PRAGMA user_version = 4;
             COMMIT;",
        )?;
    }
    let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if current < 5 {
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'video';
             ALTER TABLE tasks ADD COLUMN extras_error TEXT;
             ALTER TABLE history ADD COLUMN kind TEXT NOT NULL DEFAULT 'video';
             ALTER TABLE history ADD COLUMN extras_error TEXT;
             PRAGMA user_version = 5;
             COMMIT;",
        )?;
    }
    let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if current < 6 {
        // 版本回退的旧库可能仍带着这一列（DROP 后再升版本），先探测避免重复 ADD。
        let has_options: bool = conn
            .prepare("PRAGMA table_info(tasks)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(Result::ok)
            .any(|name| name == "options_json");
        if !has_options {
            conn.execute_batch(
                "ALTER TABLE tasks ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}';",
            )?;
        }
        conn.execute_batch("PRAGMA user_version = 6;")?;
    }
    Ok(())
}

fn task_by_id(conn: &Connection, id: &str) -> Result<Option<Task>, DbError> {
    conn.query_row(
        &format!("SELECT {TASK_COLUMNS} FROM tasks WHERE id = ?1"),
        params![id],
        task_from_row,
    )
    .optional()
    .map_err(DbError::from)
}

fn task_from_row(row: &Row<'_>) -> rusqlite::Result<Task> {
    let status: String = row.get(14)?;
    let kind: String = row.get(30)?;
    let danmaku: String = row.get(19)?;
    let subtitles: String = row.get(20)?;
    Ok(Task {
        id: row.get(0)?,
        kind: TaskKind::from_db(&kind),
        source_url: row.get(1)?,
        bvid: row.get(2)?,
        title: row.get(3)?,
        uploader: row.get(4)?,
        cover_url: row.get(5)?,
        duration_seconds: opt_i64_to_u64(row.get(6)?),
        format_id: row.get(7)?,
        quality_label: row.get(8)?,
        container: row.get(9)?,
        size_bytes: opt_i64_to_u64(row.get(10)?),
        downloaded_bytes: row.get::<_, i64>(11)?.max(0) as u64,
        speed_bytes_per_sec: row.get(12)?,
        eta_seconds: opt_i64_to_u64(row.get(13)?),
        status: TaskStatus::from_db(&status),
        error_code: row.get(15)?,
        error_message: row.get(16)?,
        extras_error: row.get(31)?,
        output_path: row.get(17)?,
        temp_dir: row.get(18)?,
        danmaku_types: serde_json::from_str(&danmaku).unwrap_or_default(),
        subtitle_langs: serde_json::from_str(&subtitles).unwrap_or_default(),
        engine_version: row.get(21)?,
        attempt: row.get::<_, i64>(22)?.max(0) as u32,
        created_at: row.get(23)?,
        queued_at: row.get(24)?,
        started_at: row.get(25)?,
        completed_at: row.get(26)?,
        danmaku_count: row.get::<_, i64>(27)?.max(0) as u64,
        cover_path: row.get(28)?,
        retry_at: row.get(29)?,
        options: row
            .get::<_, Option<String>>(32)?
            .and_then(|raw| serde_json::from_str::<TaskOptions>(&raw).ok())
            .unwrap_or_default(),
    })
}

fn history_from_row(row: &Row<'_>) -> rusqlite::Result<HistoryEntry> {
    let danmaku: String = row.get(13)?;
    let subtitles: String = row.get(14)?;
    let output_path: Option<String> = row.get(12)?;
    let kind = TaskKind::from_db(&row.get::<_, String>(18)?);
    Ok(HistoryEntry {
        id: row.get(0)?,
        kind,
        task_id: row.get(1)?,
        source_url: row.get(2)?,
        bvid: row.get(3)?,
        title: row.get(4)?,
        uploader: row.get(5)?,
        cover_url: row.get(6)?,
        duration_seconds: opt_i64_to_u64(row.get(7)?),
        format_id: row.get(8)?,
        quality_label: row.get(9)?,
        container: row.get(10)?,
        size_bytes: opt_i64_to_u64(row.get(11)?),
        output_path: output_path.clone(),
        danmaku_types: serde_json::from_str(&danmaku).unwrap_or_default(),
        subtitle_langs: serde_json::from_str(&subtitles).unwrap_or_default(),
        extras_error: row.get(19)?,
        completed_at: row.get(15)?,
        danmaku_count: row.get::<_, i64>(16)?.max(0) as u64,
        cover_path: row.get(17)?,
        missing_file: output_path
            .as_deref()
            .map(|path| {
                let path = std::path::Path::new(path);
                match kind {
                    TaskKind::Extras => !path.is_dir(),
                    TaskKind::Video => !path.is_file(),
                }
            })
            .unwrap_or(true),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{TaskKind, TaskSpec, TaskStatus};

    fn sample_task() -> Task {
        let spec = TaskSpec {
            kind: TaskKind::Video,
            source_url: "https://www.bilibili.com/video/BV1xx411c7mD".into(),
            bvid: Some("BV1xx411c7mD".into()),
            format_id: "30080".into(),
            quality_label: "1080P".into(),
            container: Some("mp4".into()),
            title: Some("测试视频".into()),
            uploader: Some("测试 UP".into()),
            cover_url: None,
            cover_path: None,
            duration_seconds: Some(120),
            size_bytes: Some(1024),
            danmaku_types: vec!["scroll".into()],
            danmaku_count: 0,
            subtitle_langs: vec!["zh-Hans".into()],
            options: Default::default(),
        };
        Task {
            options: Default::default(),
            id: "task_test".into(),
            kind: TaskKind::Video,
            source_url: spec.source_url,
            bvid: Some("BV1xx411c7mD".into()),
            title: spec.title.unwrap(),
            uploader: spec.uploader.unwrap(),
            cover_url: None,
            cover_path: Some("C:\\cache\\task-cover.jpg".into()),
            duration_seconds: spec.duration_seconds,
            format_id: spec.format_id,
            quality_label: spec.quality_label,
            container: spec.container.unwrap(),
            size_bytes: spec.size_bytes,
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
            engine_version: Some("test".into()),
            attempt: 0,
            created_at: 1,
            queued_at: Some(1),
            started_at: None,
            completed_at: None,
            retry_at: None,
        }
    }

    #[test]
    fn settings_round_trip_and_defaults() {
        let db = Db::open_in_memory().unwrap();
        let settings = db.load_settings("C:\\Videos").unwrap();
        assert_eq!(settings.max_concurrent, 2);
        assert_eq!(settings.download_dir, "C:\\Videos");
        assert_eq!(settings.retry_max, 3);
        assert_eq!(settings.retry_base_seconds, 15);
        assert_eq!(settings.fragment_retries, 5);

        let mut changed = settings.clone();
        changed.max_concurrent = 4;
        changed.theme = "dark".into();
        changed.retry_max = 6;
        changed.retry_base_seconds = 45;
        changed.fragment_retries = 2;
        db.save_settings(&changed).unwrap();
        let loaded = db.load_settings("C:\\Videos").unwrap();
        assert_eq!(loaded.max_concurrent, 4);
        assert_eq!(loaded.theme, "dark");
        assert_eq!(loaded.retry_max, 6);
        assert_eq!(loaded.retry_base_seconds, 45);
        assert_eq!(loaded.fragment_retries, 2);
    }

    #[test]
    fn legacy_settings_json_keeps_user_values_when_retry_fields_are_missing() {
        // 旧版 JSON 没有重试字段：必须取默认值，且不得把用户的目录/模板/主题重置。
        let legacy = r#"{
            "theme": "dark",
            "downloadDir": "D:\\我的视频",
            "maxConcurrent": 3,
            "rateLimitKbps": 2048,
            "filenameTemplate": "{up}/{title}",
            "preferredQuality": "80",
            "notifyOnComplete": false,
            "minimizeToTray": true
        }"#;
        let db = Db::open_in_memory().unwrap();
        {
            let conn = db.lock();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![SETTINGS_KEY, legacy],
            )
            .unwrap();
        }
        let loaded = db.load_settings("C:\\Videos").unwrap();
        assert_eq!(loaded.theme, "dark");
        assert_eq!(loaded.download_dir, "D:\\我的视频");
        assert_eq!(loaded.max_concurrent, 3);
        assert_eq!(loaded.rate_limit_kbps, 2048);
        assert_eq!(loaded.filename_template, "{up}/{title}");
        // 新字段取默认值，而不是让整份设置回退。
        assert_eq!(loaded.retry_max, 3);
        assert_eq!(loaded.retry_base_seconds, 15);
        assert_eq!(loaded.fragment_retries, 5);
    }

    #[test]
    fn broken_settings_json_is_backed_up_before_falling_back() {
        // 结构损坏（不是取值越界）时必须先留证据再回退，否则用户偏好无从恢复。
        let db = Db::open_in_memory().unwrap();
        let broken = "{ 这不是 JSON";
        {
            let conn = db.lock();
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![SETTINGS_KEY, broken],
            )
            .unwrap();
        }

        let loaded = db.load_settings("C:\\Videos").unwrap();
        assert_eq!(loaded.max_concurrent, 2, "结构损坏应回退默认值");
        assert_eq!(loaded.download_dir, "C:\\Videos");

        let conn = db.lock();
        let backup: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![BROKEN_SETTINGS_KEY],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(backup, broken, "损坏的原文必须原样保留");
    }

    #[test]
    fn repeated_broken_settings_keep_only_the_latest_backup() {
        let db = Db::open_in_memory().unwrap();
        for broken in ["{ 第一次损坏", "{ 第二次损坏"] {
            {
                let conn = db.lock();
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![SETTINGS_KEY, broken],
                )
                .unwrap();
            }
            db.load_settings("C:\\Videos").unwrap();
        }

        let conn = db.lock();
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key = ?1",
                params![BROKEN_SETTINGS_KEY],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 1, "备份只保留最新一份，不随次数累积");
        let backup: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![BROKEN_SETTINGS_KEY],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(backup, "{ 第二次损坏");
    }

    #[test]
    fn settings_validate_clamps_retry_fields() {
        let mut settings = Settings::defaults("C:\\Videos".into());
        settings.retry_max = 999;
        settings.retry_base_seconds = 1;
        settings.fragment_retries = 999;
        settings.validate("C:\\Videos");
        assert_eq!(settings.retry_max, 10);
        assert_eq!(settings.retry_base_seconds, 3);
        assert_eq!(settings.fragment_retries, 20);
    }

    #[test]
    fn duplicate_guard_is_atomic_for_active_tasks() {
        let db = Db::open_in_memory().unwrap();
        let task = sample_task();
        assert!(db.insert_task_if_no_active_duplicate(&task).unwrap());
        assert!(!db.insert_task_if_no_active_duplicate(&task).unwrap());
        assert_eq!(db.list_tasks().unwrap().len(), 1);
    }

    #[test]
    fn duplicate_guard_blocks_failed_but_allows_cancelled_and_completed() {
        let db = Db::open_in_memory().unwrap();
        let mut task = sample_task();
        task.status = TaskStatus::Failed;
        assert!(db.insert_task_if_no_active_duplicate(&task).unwrap());

        let mut retry = task.clone();
        retry.id = "task_retry".into();
        assert!(!db.insert_task_if_no_active_duplicate(&retry).unwrap());
        retry.status = TaskStatus::Queued;

        task.status = TaskStatus::Cancelled;
        db.update_task(&task).unwrap();
        assert!(db.insert_task_if_no_active_duplicate(&retry).unwrap());

        let mut completed = task.clone();
        completed.id = "task_done".into();
        completed.status = TaskStatus::Completed;
        retry.status = TaskStatus::Cancelled;
        db.update_task(&retry).unwrap();
        assert!(db.insert_task_if_no_active_duplicate(&completed).unwrap());
    }

    #[test]
    fn conditional_update_does_not_overwrite_cancelled() {
        let db = Db::open_in_memory().unwrap();
        let mut task = sample_task();
        db.insert_task(&task).unwrap();
        task.status = TaskStatus::Cancelled;
        db.update_task(&task).unwrap();

        let mut completed = task.clone();
        completed.status = TaskStatus::Completed;
        assert!(!db
            .update_task_if_status(&completed, TaskStatus::Extras)
            .unwrap());
        assert_eq!(
            db.get_task("task_test").unwrap().unwrap().status,
            TaskStatus::Cancelled
        );
    }

    #[test]
    fn clear_completed_keeps_cancelled_and_failed_rows() {
        let db = Db::open_in_memory().unwrap();
        let mut completed = sample_task();
        completed.id = "completed".into();
        completed.status = TaskStatus::Completed;
        db.insert_task(&completed).unwrap();
        let mut cancelled = sample_task();
        cancelled.id = "cancelled".into();
        cancelled.status = TaskStatus::Cancelled;
        db.insert_task(&cancelled).unwrap();
        let mut failed = sample_task();
        failed.id = "failed".into();
        failed.status = TaskStatus::Failed;
        db.insert_task(&failed).unwrap();

        db.clear_completed().unwrap();
        let ids: Vec<String> = db
            .list_tasks()
            .unwrap()
            .into_iter()
            .map(|task| task.id)
            .collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"cancelled".to_string()));
        assert!(ids.contains(&"failed".to_string()));
    }

    #[test]
    fn round_trips_extras_tasks_and_separates_duplicates() {
        let db = Db::open_in_memory().unwrap();
        let video = sample_task();
        assert!(db.insert_task_if_no_active_duplicate(&video).unwrap());

        let mut extras = sample_task();
        extras.id = "extras_task".into();
        extras.kind = TaskKind::Extras;
        extras.format_id = String::new();
        extras.quality_label = "附加内容".into();
        extras.container = "extras".into();
        extras.extras_error = Some("弹幕写入失败".into());
        assert!(db.insert_task_if_no_active_duplicate(&extras).unwrap());

        let loaded = db.get_task("extras_task").unwrap().unwrap();
        assert_eq!(loaded.kind, TaskKind::Extras);
        assert_eq!(loaded.extras_error.as_deref(), Some("弹幕写入失败"));

        let mut another = extras.clone();
        another.id = "extras_task_2".into();
        assert!(!db.insert_task_if_no_active_duplicate(&another).unwrap());
    }

    #[test]
    fn task_round_trip_and_recovery() {
        let db = Db::open_in_memory().unwrap();
        let mut task = sample_task();
        task.retry_at = Some(12345);
        db.insert_task(&task).unwrap();
        let tasks = db.list_tasks().unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].quality_label, "1080P");
        assert_eq!(tasks[0].danmaku_types, vec!["scroll"]);
        assert_eq!(
            tasks[0].cover_path.as_deref(),
            Some("C:\\cache\\task-cover.jpg")
        );

        let mut active = task.clone();
        active.status = TaskStatus::Downloading;
        active.retry_at = Some(99999);
        db.update_task(&active).unwrap();
        assert_eq!(db.recover_interrupted_tasks().unwrap(), 1);
        let recovered = db.get_task("task_test").unwrap().unwrap();
        assert_eq!(recovered.status, TaskStatus::Paused);
        assert_eq!(recovered.error_code.as_deref(), Some("interrupted"));
        assert!(recovered.retry_at.is_none());
    }

    #[test]
    fn backs_up_before_upgrading_v2_database() {
        let directory =
            std::env::temp_dir().join(format!("bilipocket_db_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("bilipocket.db");
        {
            let db = Db::open(&path).unwrap();
            db.insert_task(&sample_task()).unwrap();
        }
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "PRAGMA user_version = 2;
                 ALTER TABLE tasks DROP COLUMN cover_path;
                 ALTER TABLE history DROP COLUMN cover_path;
                 ALTER TABLE tasks DROP COLUMN retry_at;
                 ALTER TABLE tasks DROP COLUMN kind;
                 ALTER TABLE tasks DROP COLUMN extras_error;
                 ALTER TABLE history DROP COLUMN kind;
                 ALTER TABLE history DROP COLUMN extras_error;",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let tasks = db.list_tasks().unwrap();
        assert_eq!(tasks.len(), 1);
        assert!(tasks[0].cover_path.is_none());
        assert!(path.with_extension("db.bak-v2").is_file());
        drop(db);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn history_treats_extras_folder_as_present() {
        let directory =
            std::env::temp_dir().join(format!("bilipocket_hist_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let db = Db::open_in_memory().unwrap();
        let entry = HistoryEntry {
            id: "hist_extras".into(),
            kind: TaskKind::Extras,
            task_id: None,
            source_url: "https://www.bilibili.com/video/BV1xx411c7mD".into(),
            bvid: None,
            title: "附加内容".into(),
            uploader: "UP".into(),
            cover_url: None,
            cover_path: None,
            duration_seconds: None,
            format_id: String::new(),
            quality_label: "1080P".into(),
            container: "extras".into(),
            size_bytes: Some(100),
            output_path: Some(directory.to_string_lossy().into_owned()),
            danmaku_types: vec!["scroll".into()],
            danmaku_count: 2,
            subtitle_langs: vec!["zh-Hans".into()],
            extras_error: Some("部分字幕未生成".into()),
            completed_at: 1,
            missing_file: false,
        };
        db.insert_history(&entry).unwrap();

        let loaded = db.list_history().unwrap();
        assert_eq!(loaded[0].kind, TaskKind::Extras);
        assert_eq!(loaded[0].extras_error.as_deref(), Some("部分字幕未生成"));
        assert!(!loaded[0].missing_file);

        std::fs::remove_dir_all(&directory).unwrap();
        let missing = db.list_history().unwrap();
        assert!(missing[0].missing_file);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn mark_task_paused_keeps_metadata_and_guards_state() {
        let db = Db::open_in_memory().unwrap();
        let mut task = sample_task();
        task.title = "保留标题".into();
        task.temp_dir = Some("C:\\parts\\task_test".into());
        task.status = TaskStatus::Downloading;
        db.insert_task(&task).unwrap();

        let paused = db
            .mark_task_paused(&task.id, None, None)
            .unwrap()
            .expect("active task should pause");
        assert_eq!(paused.status, TaskStatus::Paused);
        assert_eq!(paused.title, "保留标题");
        assert_eq!(paused.temp_dir.as_deref(), Some("C:\\parts\\task_test"));
        assert!(paused.retry_at.is_none());

        assert!(db.mark_task_paused(&task.id, None, None).unwrap().is_none());
    }

    #[test]
    fn conditional_updates_do_not_overwrite_paused_or_metadata() {
        let db = Db::open_in_memory().unwrap();
        let task = sample_task();
        db.insert_task(&task).unwrap();
        db.mark_task_paused(&task.id, None, None).unwrap();

        let mut failed = task.clone();
        failed.status = TaskStatus::Failed;
        failed.error_message = Some("下载失败".into());
        assert!(!db
            .update_task_if_status_in(&failed, &[TaskStatus::Probing, TaskStatus::Downloading],)
            .unwrap());

        let mut renamed = task.clone();
        renamed.title = "不应写入".into();
        renamed.status = TaskStatus::Probing;
        assert!(!db
            .update_task_metadata_if_status(&renamed, &[TaskStatus::Probing])
            .unwrap());

        let stored = db.get_task(&task.id).unwrap().unwrap();
        assert_eq!(stored.status, TaskStatus::Paused);
        assert_eq!(stored.title, "测试视频");
    }

    #[test]
    fn history_round_trip_and_limit() {
        let db = Db::open_in_memory().unwrap();
        for index in 0..120 {
            let entry = HistoryEntry {
                id: format!("hist_{index}"),
                kind: TaskKind::Video,
                task_id: None,
                source_url: "https://www.bilibili.com/video/BV1xx411c7mD".into(),
                bvid: None,
                title: format!("视频 {index}"),
                uploader: "UP".into(),
                cover_url: None,
                cover_path: None,
                duration_seconds: None,
                format_id: "30080".into(),
                quality_label: "1080P".into(),
                container: "mp4".into(),
                size_bytes: Some(100),
                output_path: None,
                danmaku_types: vec![],
                danmaku_count: 0,
                subtitle_langs: vec![],
                extras_error: None,
                completed_at: index as i64,
                missing_file: false,
            };
            db.insert_history(&entry).unwrap();
        }
        let history = db.list_history().unwrap();
        assert_eq!(history.len(), HISTORY_LIMIT as usize);
        assert_eq!(history[0].id, "hist_119");
    }
}
