use std::sync::Arc;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, State, WebviewWindow,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

mod auth;
mod bilibili;
mod commands;
mod covers;
mod db;
mod diagnostics;
mod domain;
mod engine;
mod files;
mod postprocess;
mod process_job;
mod queue;
mod state;
mod updates;
mod util;

use auth::AuthManager;
use db::Db;
use engine::Engine;
use queue::Queue;
use state::AppState;

#[tauri::command]
fn minimize_window(window: WebviewWindow, state: State<'_, AppState>) -> Result<(), String> {
    if state.settings().minimize_to_tray {
        let _ = window.hide();
    } else {
        let _ = window.minimize();
    }
    Ok(())
}

#[tauri::command]
fn toggle_maximize(window: WebviewWindow) -> bool {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
        false
    } else {
        let _ = window.maximize();
        true
    }
}

#[tauri::command]
fn close_window(window: WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
fn pick_directory(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("选择下载目录")
        .blocking_pick_folder()
        .map(|path| path.to_string())
}

#[tauri::command]
fn send_notification(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string())
}

fn allowed_roots(app: &tauri::AppHandle, state: &AppState) -> Vec<std::path::PathBuf> {
    let mut roots = vec![
        std::path::PathBuf::from(state.settings().download_dir),
        state.data_dir.clone(),
    ];
    if let Ok(directory) = app.path().app_log_dir() {
        roots.push(directory);
    }
    // 历史记录可能来自旧的下载目录；只放行应用自己写入过的位置。
    for path in state
        .db
        .list_tasks()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|task| task.output_path)
        .chain(
            state
                .db
                .list_history()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|entry| entry.output_path),
        )
    {
        if let Some(parent) = std::path::Path::new(&path).parent() {
            roots.push(parent.to_path_buf());
        }
    }
    roots
        .into_iter()
        .filter_map(|root| root.canonicalize().ok())
        .collect()
}

fn within_allowed_roots(path: &std::path::Path, roots: &[std::path::PathBuf]) -> bool {
    let Ok(target) = path.canonicalize() else {
        return false;
    };
    roots.iter().any(|root| target.starts_with(root))
}

#[tauri::command]
fn reveal_file(
    app: tauri::AppHandle,
    path: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let path = std::path::PathBuf::from(path);
    if !path.is_file() || !within_allowed_roots(&path, &allowed_roots(&app, &state)) {
        return Ok(false);
    }
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
fn open_directory(
    app: tauri::AppHandle,
    path: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let path = std::path::PathBuf::from(&path);
    if !path.is_dir() || !within_allowed_roots(&path, &allowed_roots(&app, &state)) {
        return Ok(false);
    }

    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| error.to_string())?;

    Ok(true)
}

fn cleanup_legacy_cookie_files(data_dir: &std::path::Path) {
    let directory = data_dir.join("tmp");
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return;
    };
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("bilipocket-cookies-")
            && name.ends_with(".txt")
            && std::fs::remove_file(entry.path()).is_ok()
        {
            removed += 1;
        }
    }
    if removed > 0 {
        log::info!("已清理 {removed} 个旧版 Cookie 临时文件");
    }
    let _ = std::fs::remove_dir(&directory);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    if updates::is_portable() {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(directory) = exe.parent() {
                context.config_mut().app.app_directories_override = Some(
                    tauri::utils::config::AppDirectoriesOverride::Root(directory.join("app-data")),
                );
            }
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("bilipocket".into()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    state.queue.stop_all();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            minimize_window,
            toggle_maximize,
            close_window,
            pick_directory,
            send_notification,
            open_directory,
            reveal_file,
            commands::bootstrap,
            commands::engine_info,
            commands::engine_refresh,
            commands::probe_video,
            commands::enqueue_task,
            commands::list_tasks,
            commands::list_history,
            commands::pause_task,
            commands::resume_task,
            commands::prioritize_task,
            commands::cancel_task,
            commands::retry_task,
            commands::delete_task,
            commands::clear_completed,
            commands::clear_tasks,
            commands::delete_history,
            commands::clear_history,
            commands::get_settings,
            commands::update_settings,
            commands::set_minimize_to_tray,
            commands::set_autostart,
            commands::auth_status,
            commands::auth_qr_start,
            commands::auth_qr_poll,
            commands::auth_logout,
            commands::export_diagnostics,
            updates::update_status,
            updates::update_check,
            updates::update_install
        ])
        .setup(|app| {
            let data_dir = if cfg!(debug_assertions) {
                std::env::var_os("BILIPOCKET_DATA_DIR")
                    .map(std::path::PathBuf::from)
                    .or_else(|| app.path().app_data_dir().ok())
            } else {
                app.path().app_data_dir().ok()
            }
            .ok_or_else(|| "无法定位应用数据目录".to_string())?;
            std::fs::create_dir_all(&data_dir)
                .map_err(|error| format!("无法创建应用数据目录：{error}"))?;
            cleanup_legacy_cookie_files(&data_dir);

            let db_path = data_dir.join("bilipocket.db");
            let db = Db::open(&db_path).map_err(|error| format!("无法打开本地数据库：{error}"))?;
            let default_download_dir = if updates::is_portable() {
                std::env::current_exe()
                    .ok()
                    .and_then(|exe| exe.parent().map(|directory| directory.join("downloads")))
                    .unwrap_or_else(|| data_dir.join("downloads"))
            } else {
                app.path()
                    .video_dir()
                    .unwrap_or_else(|_| data_dir.join("downloads"))
            }
            .to_string_lossy()
            .into_owned();
            let settings = db
                .load_settings(&default_download_dir)
                .map_err(|error| format!("无法读取设置：{error}"))?;
            db.save_settings(&settings)
                .map_err(|error| format!("无法保存设置：{error}"))?;
            let recovered = db
                .recover_interrupted_tasks()
                .map_err(|error| format!("无法恢复任务状态：{error}"))?;
            if recovered > 0 {
                log::info!("{recovered} 个未完成任务已转为暂停状态");
            }

            let resource_dir = app.path().resource_dir().ok();
            let engine = Engine::discover(resource_dir.as_deref());
            log::info!(
                "download engine available={} version={:?}",
                engine.info().available,
                engine.yt_dlp_version()
            );

            let db = Arc::new(db);
            let engine = Arc::new(engine);
            let settings = Arc::new(std::sync::Mutex::new(settings));
            let auth = Arc::new(AuthManager::new(&data_dir, updates::is_portable()));
            let queue = Arc::new(Queue::new(
                db.clone(),
                engine.clone(),
                settings.clone(),
                auth.clone(),
                data_dir.clone(),
                app.handle().clone(),
            ));

            app.manage(AppState {
                db,
                engine,
                settings,
                auth,
                queue: queue.clone(),
                default_download_dir,
                data_dir,
            });
            queue.start();

            let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 BiliPocket", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            if let Some(icon) = app.default_window_icon().cloned() {
                TrayIconBuilder::with_id("main-tray")
                    .icon(icon)
                    .tooltip("BiliPocket · 轻量哔哩下载器")
                    .menu(&menu)
                    .show_menu_on_left_click(true)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .build(app)?;
            }

            Ok(())
        })
        .run(context)
        .expect("error while running BiliPocket");
}

#[cfg(test)]
mod tests {
    use super::within_allowed_roots;

    #[test]
    fn path_fence_allows_only_configured_roots() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("bilipocket-fence-{}-{stamp}", std::process::id()));
        let inside = root.join("nested");
        let outside = std::env::temp_dir().join(format!(
            "{}-outside",
            root.file_name().unwrap().to_string_lossy()
        ));
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(inside.join("video.mp4"), b"x").unwrap();

        let roots = vec![root.canonicalize().unwrap()];
        assert!(within_allowed_roots(&inside.join("video.mp4"), &roots));
        assert!(within_allowed_roots(&inside, &roots));
        assert!(!within_allowed_roots(&outside, &roots));
        assert!(!within_allowed_roots(
            &root.join("..").join("missing"),
            &roots
        ));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
