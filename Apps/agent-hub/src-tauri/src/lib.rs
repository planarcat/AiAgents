mod hub;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      let handle = app.handle().clone();
      hub::setup(&handle)?;
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      hub::hub_health,
      hub::hub_db_ping,
      hub::agents::agents_list,
      hub::agents::agents_create,
      hub::agents::agents_import_bulk,
      hub::settings::settings_api_key_configured,
      hub::settings::settings_save_api_key,
      hub::settings::settings_clear_api_key,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
