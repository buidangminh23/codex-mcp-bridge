SELECT json_build_object(
  'collectedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'active', (SELECT json_build_object(
    'day', count(DISTINCT install_id) FILTER (WHERE day = (now() AT TIME ZONE 'UTC')::date),
    'week', count(DISTINCT install_id) FILTER (WHERE day >= (now() AT TIME ZONE 'UTC')::date - 6),
    'month', count(DISTINCT install_id) FILTER (WHERE day >= (now() AT TIME ZONE 'UTC')::date - 29)
  ) FROM public.bridge_usage_daily),
  'daily', (SELECT coalesce(json_agg(rows ORDER BY day), '[]'::json) FROM (
    SELECT day, count(*) AS installations FROM public.bridge_usage_daily GROUP BY day
  ) rows),
  'platforms', (SELECT coalesce(json_agg(rows ORDER BY platform), '[]'::json) FROM (
    SELECT platform, count(DISTINCT install_id) AS installations FROM public.bridge_usage_daily
    WHERE day >= (now() AT TIME ZONE 'UTC')::date - 29 GROUP BY platform
  ) rows),
  'versions', (SELECT coalesce(json_agg(rows ORDER BY version), '[]'::json) FROM (
    SELECT version, count(DISTINCT install_id) AS installations FROM public.bridge_usage_daily
    WHERE day >= (now() AT TIME ZONE 'UTC')::date - 29 GROUP BY version
  ) rows)
) AS summary;
