mod hub;

use tauri::Manager;

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
        if let Some(w) = app.get_webview_window("main") {
          w.open_devtools();
        }
      }
      let handle = app.handle().clone();
      hub::setup(&handle)?;
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      hub::hub_health,
      hub::hub_db_ping,
      hub::agents::agents_list,
      hub::agents::agents_get,
      hub::agents::agents_create,
      hub::agents::agents_create_default_template,
      hub::agents::agents_delete,
      hub::agents::agents_update,
      hub::agents::agents_import_bulk,
      hub::skills::skills_catalog,
      hub::chat::conversations_ensure,
      hub::chat::conversations_set_llm_preset,
      hub::chat::messages_list,
      hub::chat::messages_append_user_for_agent,
      hub::chat::chat_send,
      hub::chat::compress_conversations_after_skill_change,
      hub::settings::settings_llm_key_configured,
      hub::settings::settings_save_llm_key,
      hub::settings::settings_clear_llm_key,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
