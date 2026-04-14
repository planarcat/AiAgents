-- 可选内置：实时天气（Open-Meteo + 地理编码，无需用户 API Key）
INSERT OR IGNORE INTO skills (id, builtin_code, name, description, parameters_json, handler) VALUES
(
    'skill-builtin-weather',
    'weather_openmeteo',
    'query_weather_openmeteo',
    '查询指定地点的当前天气（使用 Open-Meteo 公开接口，数据为实时/近实时）。请传入用户关心的城市或地区中文名。',
    '{"type":"object","properties":{"location":{"type":"string","description":"城市或地区名称，例如：北京、上海、纽约"}},"required":["location"]}',
    'builtin'
);
