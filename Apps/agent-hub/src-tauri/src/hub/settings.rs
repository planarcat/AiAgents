//! 模型 API 密钥（OpenAI 兼容），存系统凭据，不显式回传密钥内容。

use keyring::Entry;

const KEY_SERVICE: &str = "com.aiagents.agenthub";
const KEY_USER: &str = "openai_compatible_api_key";

#[tauri::command]
pub fn settings_api_key_configured() -> bool {
    Entry::new(KEY_SERVICE, KEY_USER)
        .ok()
        .and_then(|e| e.get_password().ok())
        .map(|p| !p.is_empty())
        .unwrap_or(false)
}

#[tauri::command]
pub fn settings_save_api_key(key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("密钥不能为空".into());
    }
    let entry = Entry::new(KEY_SERVICE, KEY_USER).map_err(|e| e.to_string())?;
    entry.set_password(key.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn settings_clear_api_key() -> Result<(), String> {
    let entry = Entry::new(KEY_SERVICE, KEY_USER).map_err(|e| e.to_string())?;
    let _ = entry.delete_credential();
    Ok(())
}
