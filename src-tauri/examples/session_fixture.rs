use keyring::Entry;

fn main() {
    let entry = match Entry::new("BiliPocket", "bilibili-session") {
        Ok(entry) => entry,
        Err(error) => {
            eprintln!("ENTRY_ERROR {error}");
            std::process::exit(2);
        }
    };
    match std::env::args().nth(1).as_deref() {
        Some("read") => match entry.get_password() {
            Ok(_) => println!("PRESENT"),
            Err(keyring::Error::NoEntry) => println!("NONE"),
            Err(error) => {
                eprintln!("READ_ERROR {error}");
                std::process::exit(2);
            }
        },
        Some("set-fake") => {
            let session = serde_json::json!({
                "account": {
                    "mid": 1,
                    "name": "过期测试账号",
                    "avatar_url": null,
                    "vip": false
                },
                "cookies": [{
                    "name": "SESSDATA",
                    "value": "invalid-test-session",
                    "domain": ".bilibili.com",
                    "path": "/",
                    "secure": true
                }]
            });
            let payload = serde_json::to_string(&session).expect("serialize fake session");
            if let Err(error) = entry.set_password(&payload) {
                eprintln!("SET_ERROR {error}");
                std::process::exit(2);
            }
            println!("SET");
        }
        Some("clear") => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => println!("CLEARED"),
            Err(error) => {
                eprintln!("CLEAR_ERROR {error}");
                std::process::exit(2);
            }
        },
        _ => {
            eprintln!("usage: session_fixture read|set-fake|clear");
            std::process::exit(1);
        }
    }
}
