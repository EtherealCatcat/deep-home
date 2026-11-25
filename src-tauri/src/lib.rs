use std::{
  fs::{create_dir_all, OpenOptions},
  io::{BufRead, BufReader, Write},
  net::{TcpListener, TcpStream},
  path::PathBuf,
  process::{Child, Command, Stdio},
  sync::Mutex,
  time::Duration,
};
use tauri::{
  image::Image,
  menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem},
  tray::{TrayIcon, TrayIconBuilder},
  AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry,
};

// macOS 原生通知通道：绕开已废弃的 NSUserNotificationCenter，
// 让 App 在前台时也能弹横幅（见 src/mac_notify.m）。
#[cfg(target_os = "macos")]
mod mac_notify {
  use std::{
    ffi::CString,
    os::raw::{c_char, c_int},
    sync::OnceLock,
  };
  use tauri::{AppHandle, Emitter};

  unsafe extern "C" {
    fn dh_notify_supported() -> c_int;
    fn dh_notify_init(callback: extern "C" fn());
    fn dh_notify(title: *const c_char, body: *const c_char, sound: c_int);
  }

  static APP: OnceLock<AppHandle> = OnceLock::new();

  extern "C" fn on_notification_click() {
    if let Some(app) = APP.get() {
      let _ = app.emit("notification-clicked", ());
    }
  }

  pub fn supported() -> bool {
    unsafe { dh_notify_supported() != 0 }
  }

  pub fn init(app: AppHandle) {
    let _ = APP.set(app);
    if !supported() {
      return;
    }
    unsafe { dh_notify_init(on_notification_click) };
  }

  pub fn send(title: &str, body: &str, sound: bool) -> bool {
    if !supported() {
      return false;
    }
    let (Ok(title), Ok(body)) = (CString::new(title), CString::new(body)) else {
      return false;
    };
    unsafe { dh_notify(title.as_ptr(), body.as_ptr(), if sound { 1 } else { 0 }) };
    true
  }
}

#[tauri::command]
fn notify_supported() -> bool {
  #[cfg(target_os = "macos")]
  {
    mac_notify::supported()
  }
  #[cfg(not(target_os = "macos"))]
  {
    false
  }
}

#[tauri::command]
fn notify_native(title: String, body: String, sound: Option<bool>) -> Result<(), String> {
  #[cfg(target_os = "macos")]
  {
    if mac_notify::send(&title, &body, sound.unwrap_or(true)) {
      Ok(())
    } else {
      Err("原生通知通道不可用".to_string())
    }
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = (title, body, sound);
    Err("当前平台不支持原生通知通道".to_string())
  }
}

struct ServerState {
  port: u16,
  child: Mutex<Option<Child>>,
}

struct TrayState {
  _tray: Mutex<Option<TrayIcon<Wry>>>,
  msg_item: MenuItem<Wry>,
  own_item: MenuItem<Wry>,
}

const TRAY_TEMPLATE: &[u8] = include_bytes!("../tray-icons/dark/template.png");

fn show_main(app: &AppHandle, page: Option<&str>) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
  }
  if let Some(page) = page {
    let _ = app.emit("navigate", page);
  }
}

fn handle_menu(app: &AppHandle, id: &str) {
  match id {
    "msg" => show_main(app, Some("chat")),
    "own" => show_main(app, Some("today")),
    "diary" => show_main(app, Some("diary")),
    "growth" => show_main(app, Some("growth")),
    "settings" => show_main(app, Some("settings")),
    "quit" => app.exit(0),
    _ => {}
  }
}

#[tauri::command]
fn server_port(state: State<ServerState>) -> u16 {
  state.port
}

#[tauri::command]
fn focus_main(app: tauri::AppHandle) {
  show_main(&app, None);
}

#[tauri::command]
fn update_tray(app: AppHandle, unread: u32, own: u32, label: String) {
  if let Some(state) = app.try_state::<TrayState>() {
    let msg_text = if unread > 0 {
      format!("{unread} 条新消息")
    } else {
      "暂无新消息".to_string()
    };
    let _ = state.msg_item.set_text(msg_text);

    let own_text = if own > 0 {
      let clean = label.replace(['\n', '\r'], " ").trim().to_string();
      let short: String = if clean.chars().count() > 18 {
        format!("{}…", clean.chars().take(18).collect::<String>())
      } else {
        clean
      };
      if short.is_empty() {
        "有新活动".to_string()
      } else {
        format!("有新活动：{short}")
      }
    } else {
      "暂无新活动".to_string()
    };
    let _ = state.own_item.set_text(own_text);
  }
}

fn log_dir() -> PathBuf {
  let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
  PathBuf::from(home).join("Library").join("Logs").join("DeepHome")
}

#[tauri::command]
fn open_logs() -> Result<(), String> {
  let dir = log_dir();
  create_dir_all(&dir).map_err(|error| error.to_string())?;
  Command::new("open")
    .arg(&dir)
    .spawn()
    .map_err(|error| error.to_string())?;
  Ok(())
}

fn free_port() -> Result<u16, String> {
  let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
  let port = listener.local_addr().map_err(|error| error.to_string())?.port();
  drop(listener);
  Ok(port)
}

fn pipe_logs<R: std::io::Read + Send + 'static>(reader: R, path: PathBuf) {
  std::thread::spawn(move || {
    let mut file = match OpenOptions::new().create(true).append(true).open(&path) {
      Ok(file) => file,
      Err(_) => return,
    };
    for line in BufReader::new(reader).lines().map_while(Result::ok) {
      let _ = writeln!(file, "{line}");
      let _ = file.flush();
    }
  });
}

fn spawn_server(app: &tauri::AppHandle) -> Result<(u16, Child), String> {
  let resource = app.path().resource_dir().map_err(|error| error.to_string())?;
  let node = resource.join("node");
  let server = resource.join("server.mjs");
  let assets = resource.join("assets");
  if !node.exists() || !server.exists() {
    return Err(format!("sidecar 资源不完整：{} / {}", node.display(), server.display()));
  }

  let dir = log_dir();
  create_dir_all(&dir).map_err(|error| error.to_string())?;
  let mut log = OpenOptions::new()
    .create(true)
    .append(true)
    .open(dir.join("server.log"))
    .map_err(|error| error.to_string())?;
  let _ = writeln!(log, "\n--- DeepHome sidecar start {} ---", chrono_like_now());

  let port = free_port()?;
  let mut child = Command::new(&node)
    .arg(&server)
    .env("DEEPHOME_PORT", port.to_string())
    .env("DEEPHOME_ASSETS_DIR", &assets)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|error| format!("启动 sidecar 失败：{error}"))?;

  if let Some(stdout) = child.stdout.take() {
    pipe_logs(stdout, dir.join("server.log"));
  }
  if let Some(stderr) = child.stderr.take() {
    pipe_logs(stderr, dir.join("server.log"));
  }

  for _ in 0..120 {
    if TcpStream::connect(("127.0.0.1", port)).is_ok() {
      return Ok((port, child));
    }
    std::thread::sleep(Duration::from_millis(100));
  }
  let _ = child.kill();
  Err(format!("sidecar 没有在 12 秒内监听端口 {port}"))
}

fn chrono_like_now() -> String {
  use std::time::{SystemTime, UNIX_EPOCH};
  let seconds = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
  seconds.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      show_main(app, None);
    }))
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_autostart::init(
      tauri_plugin_autostart::MacosLauncher::LaunchAgent,
      None,
    ))
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let (port, child) = if cfg!(debug_assertions) {
        (7788_u16, None)
      } else {
        let (port, child) = spawn_server(app.handle())?;
        (port, Some(child))
      };
      app.manage(ServerState {
        port,
        child: Mutex::new(child),
      });

      let msg_item = MenuItem::with_id(app, "msg", "暂无新消息", true, None::<&str>)?;
      let own_item = MenuItem::with_id(app, "own", "暂无新活动", true, None::<&str>)?;
      let diary_item = MenuItem::with_id(app, "diary", "查看日记", true, None::<&str>)?;
      let growth_item = MenuItem::with_id(app, "growth", "查看成长", true, None::<&str>)?;
      let settings_item = MenuItem::with_id(app, "settings", "转到设置", true, None::<&str>)?;
      let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
      let sep1 = PredefinedMenuItem::separator(app)?;
      let sep2 = PredefinedMenuItem::separator(app)?;
      let items: [&dyn IsMenuItem<Wry>; 8] = [
        &msg_item,
        &own_item,
        &sep1,
        &diary_item,
        &growth_item,
        &sep2,
        &settings_item,
        &quit_item,
      ];
      let menu = Menu::with_items(app, &items)?;
      let tray = TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(TRAY_TEMPLATE)?)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .build(app)?;
      app.manage(TrayState {
        _tray: Mutex::new(Some(tray)),
        msg_item,
        own_item,
      });

      let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("DeepHome")
        .inner_size(1180.0, 780.0)
        .min_inner_size(900.0, 620.0)
        .center()
        .on_new_window(|url, _features| {
          // 只允许公开 http/https；前端也做了一次 scheme 校验。
          if matches!(url.scheme(), "http" | "https") {
            if let Err(error) = Command::new("/usr/bin/open").arg(url.as_str()).spawn() {
              eprintln!("failed to open external url: {error}");
            }
          }
          tauri::webview::NewWindowResponse::Deny
        })
        .build()?;

      let window_handle = window.clone();
      window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
          api.prevent_close();
          let _ = window_handle.hide();
        }
      });

      #[cfg(target_os = "macos")]
      {
        mac_notify::init(app.handle().clone());

        // 调试用：`DeepHome.app/Contents/MacOS/app --notify-test` 启动后 5 秒发一条自检通知，
        // 用来确认 App 在前台时横幅能正常弹出。
        if std::env::args().any(|arg| arg == "--notify-test") {
          std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(5));
            mac_notify::send("鲸鲸", "通知自检：这条应该从右上角弹出来。", true);
          });
        }
      }

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      server_port,
      focus_main,
      open_logs,
      update_tray,
      notify_supported,
      notify_native
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| match event {
      tauri::RunEvent::Exit => {
        if let Some(state) = app_handle.try_state::<ServerState>() {
          if let Some(mut child) = state.child.lock().ok().and_then(|mut guard| guard.take()) {
            let _ = child.kill();
          }
        }
      }
      #[cfg(target_os = "macos")]
      tauri::RunEvent::Reopen {
        has_visible_windows,
        ..
      } => {
        if !has_visible_windows {
          show_main(app_handle, None);
        }
      }
      _ => {}
    });
}
