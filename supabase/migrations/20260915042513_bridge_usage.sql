CREATE TABLE public.bridge_usage_daily (
  day date NOT NULL,
  install_id uuid NOT NULL,
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
  platform text NOT NULL CHECK (platform IN ('windows', 'macos', 'linux')),
  PRIMARY KEY (day, install_id)
);

ALTER TABLE public.bridge_usage_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bridge_usage_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.bridge_usage_daily TO service_role;

CREATE FUNCTION public.record_bridge_usage(p_install_id uuid, p_day date, p_version text, p_platform text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET lock_timeout = '2s'
AS $function$
DECLARE
  today date := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_install_id IS NULL OR p_day IS DISTINCT FROM today
    OR p_install_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_version IS NULL OR length(p_version) NOT BETWEEN 1 AND 64
    OR p_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*)?(\+[0-9a-zA-Z-]+(\.[0-9a-zA-Z-]+)*)?$'
    OR p_platform IS NULL OR p_platform NOT IN ('windows', 'macos', 'linux') THEN
    RETURN 'invalid';
  END IF;

  IF NOT pg_try_advisory_xact_lock(1647428123, (today - DATE '2000-01-01')::integer) THEN
    RETURN 'busy';
  END IF;

  DELETE FROM public.bridge_usage_daily
  WHERE (day, install_id) IN (
    SELECT day, install_id FROM public.bridge_usage_daily
    WHERE day < today - 89 ORDER BY day, install_id LIMIT 1000
  );

  IF EXISTS (SELECT 1 FROM public.bridge_usage_daily WHERE day = today AND install_id = p_install_id) THEN
    RETURN 'duplicate';
  END IF;

  IF (SELECT count(*) FROM public.bridge_usage_daily WHERE day = today) >= 10000 THEN
    RETURN 'capacity';
  END IF;

  INSERT INTO public.bridge_usage_daily(day, install_id, version, platform)
  VALUES (today, p_install_id, p_version, p_platform);
  RETURN 'recorded';
END;
$function$;

REVOKE ALL ON FUNCTION public.record_bridge_usage(uuid, date, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_bridge_usage(uuid, date, text, text) TO service_role;

COMMENT ON TABLE public.bridge_usage_daily IS 'Opt-in daily installation counts only. No chat, path, account or IP fields. Expired rows are deleted in batches of at most 1000 on valid ingest; without traffic cleanup is deferred.';
COMMENT ON FUNCTION public.record_bridge_usage(uuid, date, text, text) IS 'Service-role-only ingest. UTC today only, first event wins per install/day, atomic daily cap of 10000, nonblocking daily lock. The cap bounds stored events, not public endpoint request volume.';
