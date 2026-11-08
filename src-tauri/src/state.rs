use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use crate::{
    auth::AuthManager, db::Db, domain::Settings, engine::Engine, queue::Queue, util::LockExt,
};

pub struct AppState {
    pub db: Arc<Db>,
    pub engine: Arc<Engine>,
    pub settings: Arc<Mutex<Settings>>,
    pub auth: Arc<AuthManager>,
    pub queue: Arc<Queue>,
    pub default_download_dir: String,
    pub data_dir: PathBuf,
}

impl AppState {
    pub fn settings(&self) -> Settings {
        self.settings.lock_or_recover("settings").clone()
    }

    pub fn set_settings(&self, settings: Settings) {
        *self.settings.lock_or_recover("settings") = settings;
    }
}
