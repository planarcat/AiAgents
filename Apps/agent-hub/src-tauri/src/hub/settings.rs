//! 模型 API 密钥按 **LLM 预设** 分区存储（系统凭据），不显式回传密钥内容。
//! 旧版单一 `openai_compatible_api_key` 仅在 `deepseek_default` 上作为读回退。

use keyring::Entry;

const KEY_SERVICE: &str = "com.aiagents.agenthub";
const KEY_USER_LEGACY: &str = "openai_compatible_api_key";

fn preset_key_user(preset_id: &str) -> String {
    format!("llm_api_key__{preset_id}")
}

fn assert_known_preset(preset_id: &str) -> Result<(), String> {
    match preset_id {
        "deepseek_default" => Ok(()),
        _ => Err(format!("不支持的大模型预设: {preset_id}")),
    }
}

fn load_legacy_key() -> Result<String, String> {
    let entry = Entry::new(KEY_SERVICE, KEY_USER_LEGACY).map_err(|e| e.to_string())?;
    let p = entry.get_password().map_err(|_| "未配置".to_string())?;
    let p = p.trim();
    if p.is_empty() {
        return Err("未配置".into());
    }
    Ok(p.to_string())
}

/// 是否已为该预设配置可用密钥（与 [`hub_load_api_key_for_preset`] 同源）。
#[tauri::command]
pub fn settings_llm_key_configured(preset_id: String) -> bool {
    hub_load_api_key_for_preset(&preset_id).is_ok()
}

#[tauri::command]
pub fn settings_save_llm_key(preset_id: String, key: String) -> Result<(), String> {
    assert_known_preset(&preset_id)?;
    if key.trim().is_empty() {
        return Err("密钥不能为空".into());
    }
    let entry = Entry::new(KEY_SERVICE, &preset_key_user(&preset_id)).map_err(|e| e.to_string())?;
    let trimmed = key.trim();
    entry
        .set_password(trimmed)
        .map_err(|e| format!("保存密钥失败：{e}"))?;
    let read_back = entry
        .get_password()
        .map_err(|e| {
            format!("密钥已保存但读回校验失败：{e}。请确认已启用系统凭据存储（Windows 凭据管理器 / 本机权限）。")
        })?;
    if read_back.trim() != trimmed {
        return Err("密钥读回与写入不一致，请重试或检查系统凭据。".into());
    }
    Ok(())
}

#[tauri::command]
pub fn settings_clear_llm_key(preset_id: String) -> Result<(), String> {
    assert_known_preset(&preset_id)?;
    let entry = Entry::new(KEY_SERVICE, &preset_key_user(&preset_id)).map_err(|e| e.to_string())?;
    let _ = entry.delete_credential();
    if preset_id == "deepseek_default" {
        let legacy = Entry::new(KEY_SERVICE, KEY_USER_LEGACY).map_err(|e| e.to_string())?;
        let _ = legacy.delete_credential();
    }
    Ok(())
}

/// 供 Hub LLM 调用（不返回给前端）。`deepseek_default` 在无分钥时尝试读旧版单一密钥。
pub fn hub_load_api_key_for_preset(preset_id: &str) -> Result<String, String> {
    assert_known_preset(preset_id)?;
    let entry = Entry::new(KEY_SERVICE, &preset_key_user(preset_id)).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(p) => {
            let p = p.trim();
            if !p.is_empty() {
                return Ok(p.to_string());
            }
            if preset_id == "deepseek_default" {
                load_legacy_key().map_err(|_| {
                    "未配置 DeepSeek 密钥。请在「大模型密钥」中为 DeepSeek 保存。".to_string()
                })
            } else {
                Err("未配置该大模型的密钥。".into())
            }
        }
        Err(_) => {
            if preset_id == "deepseek_default" {
                load_legacy_key().map_err(|_| {
                    "未配置 DeepSeek 密钥。请在「大模型密钥」中为 DeepSeek 保存。".to_string()
                })
            } else {
                Err("未配置该大模型的密钥。".into())
            }
        }
    }
}
