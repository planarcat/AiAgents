//! 内置工具实现（与 `skills.name` 一致）。

use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};

pub const TOOL_NAME_WEATHER_OPENMETEO: &str = "query_weather_openmeteo";
pub const TOOL_NAME_LIST_LOADED_SKILLS: &str = "list_my_loaded_skills";

pub async fn invoke_builtin(
    pool: &SqlitePool,
    from_agent_id: &str,
    name: &str,
    args: &Value,
) -> String {
    match name {
        "request_agent_help" => handle_delegate(pool, from_agent_id, args).await,
        TOOL_NAME_WEATHER_OPENMETEO => handle_weather(args).await,
        TOOL_NAME_LIST_LOADED_SKILLS => handle_list_loaded_skills(pool, from_agent_id).await,
        _ => format!("未知工具: {name}"),
    }
}

async fn handle_list_loaded_skills(pool: &SqlitePool, agent_id: &str) -> String {
    let rows = match sqlx::query(
        r#"SELECT s.id, s.name,
            COALESCE(NULLIF(TRIM(s.display_name), ''), s.name) AS disp,
            s.description, s.kind, s.parameters_json, s.instructions_md, s.is_default_load
         FROM skills s
         INNER JOIN agent_skills ak ON ak.skill_id = s.id
         WHERE ak.agent_id = ?
         ORDER BY s.id ASC"#,
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await
    {
        Ok(r) => r,
        Err(e) => return format!("查询已装载能力失败: {e}"),
    };

    if rows.is_empty() {
        return "当前助手未装载任何能力（数据异常时可检查 agent_skills）。".to_string();
    }

    let items: Vec<Value> = rows
        .into_iter()
        .filter_map(|row| {
            let id: String = row.try_get(0).ok()?;
            let tool_name: String = row.try_get(1).ok()?;
            let display_name: String = row.try_get(2).ok()?;
            let description: String = row.try_get(3).ok()?;
            let kind: String = row.try_get(4).ok()?;
            let parameters_json: String = row.try_get(5).ok()?;
            let instructions_md: String = row.try_get(6).ok()?;
            let is_default_load: i64 = row.try_get(7).ok()?;
            Some(json!({
                "skill_id": id,
                "tool_name": tool_name,
                "display_name": display_name,
                "description": description,
                "kind": kind,
                "parameters_json": parameters_json,
                "instructions_md": instructions_md,
                "is_default_load": is_default_load != 0,
            }))
        })
        .collect();

    serde_json::to_string_pretty(&json!({
        "agent_id": agent_id,
        "loaded_skills": items,
        "note": "以上为当前对话助手已装载能力的完整目录字段，可直接用于回答用户关于能力清单的问题。"
    }))
    .unwrap_or_else(|e| format!("序列化能力列表失败: {e}"))
}

async fn handle_weather(args: &Value) -> String {
    let loc = args
        .get("location")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if loc.is_empty() {
        return "请提供 location（城市或地区）。".into();
    }
    let client = reqwest::Client::new();
    let geo: Value = match client
        .get("https://geocoding-api.open-meteo.com/v1/search")
        .query(&[("name", loc), ("count", "1"), ("language", "zh")])
        .send()
        .await
    {
        Ok(r) => match r.error_for_status() {
            Ok(r) => match r.json().await {
                Ok(j) => j,
                Err(e) => return format!("解析地理编码响应失败: {e}"),
            },
            Err(e) => return format!("地理编码请求失败: {e}"),
        },
        Err(e) => return format!("地理编码网络错误: {e}"),
    };
    let results = match geo.get("results").and_then(|v| v.as_array()) {
        Some(a) if !a.is_empty() => a,
        _ => {
            return format!("未找到「{loc}」的坐标，请尝试其他城市或地区名称。");
        }
    };
    let first = &results[0];
    let lat = first.get("latitude").and_then(|v| v.as_f64());
    let lon = first.get("longitude").and_then(|v| v.as_f64());
    let place = first
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(loc);
    let Some((lat, lon)) = lat.zip(lon) else {
        return "地理编码返回数据不完整。".into();
    };

    let fc: Value = match client
        .get("https://api.open-meteo.com/v1/forecast")
        .query(&[
            ("latitude", lat.to_string()),
            ("longitude", lon.to_string()),
            (
                "current",
                "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m".to_string(),
            ),
            ("timezone", "auto".to_string()),
        ])
        .send()
        .await
    {
        Ok(r) => match r.error_for_status() {
            Ok(r) => match r.json().await {
                Ok(j) => j,
                Err(e) => return format!("解析天气预报响应失败: {e}"),
            },
            Err(e) => return format!("天气预报请求失败: {e}"),
        },
        Err(e) => return format!("天气预报网络错误: {e}"),
    };
    let cur = match fc.get("current").and_then(|v| v.as_object()) {
        Some(o) => o,
        None => return "预报接口未返回 current 字段。".into(),
    };
    let temp = cur
        .get("temperature_2m")
        .and_then(|v| v.as_f64())
        .map(|t| format!("{t:.1}°C"))
        .unwrap_or_else(|| "—".into());
    let rh = cur
        .get("relative_humidity_2m")
        .and_then(|v| v.as_f64())
        .map(|x| format!("{x:.0}%"))
        .unwrap_or_else(|| "—".into());
    let code = cur.get("weather_code").and_then(|v| v.as_i64());
    let code_txt = code.map(weather_code_wmo).unwrap_or("未知");
    let code_str = code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "—".into());
    let wind = cur
        .get("wind_speed_10m")
        .and_then(|v| v.as_f64())
        .map(|w| format!("{w:.1} m/s"))
        .unwrap_or_else(|| "—".into());

    format!(
        "地点：{place}（约 {lat:.4}, {lon:.4}）\n\
         气温：{temp}，相对湿度：{rh}，风速：{wind}\n\
         天气现象（WMO）：{code_txt}（代码 {code_str}）\n\
         数据来源：Open-Meteo（公开接口，近实时）。",
    )
}

fn weather_code_wmo(code: i64) -> &'static str {
    match code {
        0 => "晴朗",
        1..=3 => "多云",
        45 | 48 => "雾",
        51..=57 => "毛毛雨",
        61..=67 => "雨",
        71..=77 => "降雪",
        80..=82 => "阵雨",
        85..=86 => "阵雪",
        95 => "雷暴",
        96..=99 => "雷暴伴冰雹",
        _ => "其他",
    }
}

async fn handle_delegate(pool: &SqlitePool, from_agent_id: &str, args: &Value) -> String {
    let Some(to) = args.get("to_agent_id").and_then(|v| v.as_str()) else {
        return "委派失败: 缺少 to_agent_id".into();
    };
    let intent = args
        .get("intent")
        .and_then(|v| v.as_str())
        .unwrap_or("(未提供意图)");

    let has_delegate: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM agent_skills WHERE agent_id = ? AND skill_id = 'skill-builtin-delegate' LIMIT 1",
    )
    .bind(from_agent_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    let Some(1) = has_delegate else {
        return format!(
            "委派失败: 当前助手未装载「事务委派」能力（intent: {intent}）。请在编辑助手中将该能力置于左侧「已装载」。"
        );
    };

    let target: Option<(i64, String)> = sqlx::query_as(
        "SELECT accepts_incoming_delegation, display_name FROM agents WHERE id = ?",
    )
    .bind(to)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();

    let Some((acc, tname)) = target else {
        return format!("委派失败: 目标助手不存在（to_agent_id={to}）。intent: {intent}");
    };
    if acc != 1 {
        return format!(
            "委派失败: 助手「{tname}」不接受入站委派。intent: {intent}"
        );
    }

    if to == from_agent_id {
        return format!("委派失败: 不能委派给自己。intent: {intent}");
    }

    format!(
        "（MVP 提示）委派请求已被记录：自 {from_agent_id} → {to}（{tname}），意图: {intent}。端到端 Hub 子任务将在 M4 落地；当前请勿声称对方已实际执行完成。"
    )
}
