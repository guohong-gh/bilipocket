//! 跨模块的小工具。

use std::sync::{Mutex, MutexGuard};

/// 为 `Mutex` 增加一个「中毒也能继续」的取锁方法。
///
/// 背景：`Mutex::lock()` 在持锁线程 panic 后返回 `Err(PoisonError)`，若调用方用
/// `.expect()` 处理，就会把「一次偶发崩溃」放大成「整把锁永久不可用」——队列的三把锁
/// 任意一把中毒，暂停/取消/新增/重试就全线失效，只能重启应用。
///
/// 这里改为取回内部数据继续使用。代价是：若 panic 发生在容器修改中途，恢复出的数据
/// 可能不完整。本项目使用该方法的锁（`db` / `settings` / `running` / `jobs` / `auth`）
/// 都属于「丢了可以重建」的状态，这个取舍成立。
pub trait LockExt<T> {
    fn lock_or_recover(&self, name: &'static str) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_or_recover(&self, name: &'static str) -> MutexGuard<'_, T> {
        match self.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                warn_poisoned_once(name);
                poisoned.into_inner()
            }
        }
    }
}

/// 每把锁只告警一次，避免 `dispatch_loop` 每秒刷一条。
fn warn_poisoned_once(name: &'static str) {
    use std::sync::atomic::{AtomicU32, Ordering};
    static WARNED: AtomicU32 = AtomicU32::new(0);

    let bit = 1u32 << bit_for(name);
    if WARNED.fetch_or(bit, Ordering::Relaxed) & bit == 0 {
        log::warn!("锁 {name} 曾因 panic 中毒，已恢复并继续使用；相关状态可能不完整");
    }
}

fn bit_for(name: &str) -> u32 {
    match name {
        "db" => 0,
        "settings" => 1,
        "running" => 2,
        "jobs" => 3,
        "auth" => 4,
        _ => 5,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn recovers_from_a_poisoned_lock() {
        let mutex = Arc::new(Mutex::new(7));
        let clone = Arc::clone(&mutex);

        // 在持锁线程 panic，制造中毒状态。
        let _ = std::thread::spawn(move || {
            let _guard = clone.lock().expect("首次取锁应当成功");
            panic!("故意 panic 以制造中毒");
        })
        .join();

        assert!(mutex.lock().is_err(), "此时锁应已中毒");
        // 关键断言：不再 panic，且能读到内部数据。
        assert_eq!(*mutex.lock_or_recover("db"), 7);
    }

    #[test]
    fn works_on_a_healthy_lock() {
        let mutex = Mutex::new(String::from("ok"));
        assert_eq!(mutex.lock_or_recover("settings").as_str(), "ok");
    }
}
