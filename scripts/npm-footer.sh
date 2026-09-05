_codex_bridge_installed_version() {
  command node --input-type=module -e 'import fs from "node:fs"; const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (value.name !== "@minhspark/codex-mcp-bridge" || typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.version)) process.exit(1); process.stdout.write(value.version);' "$1/@minhspark/codex-mcp-bridge/package.json" 2>/dev/null
}

npm() {
  if [ "$#" -eq 0 ]; then command npm; return $?; fi
  local bridge_command="${1-}" bridge_global=0 bridge_packages=0 bridge_supported=1
  local bridge_dry_run=auto bridge_root= bridge_before= bridge_after= bridge_install_status=0
  local bridge_after_root= bridge_mode=unknown bridge_before_verified=1
  local -a bridge_arguments bridge_context
  bridge_arguments=("$@")
  bridge_context=(--global)
  case "$bridge_command" in
    install|i) shift ;;
    *) command npm "${bridge_arguments[@]}"; return $? ;;
  esac
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -g|--global|--global=true) bridge_global=1 ;;
      @minhspark/codex-mcp-bridge|@minhspark/codex-mcp-bridge@?*) bridge_packages=$((bridge_packages + 1)) ;;
      --dry-run|--dry-run=true) bridge_dry_run=true ;;
      --no-dry-run|--dry-run=false) bridge_dry_run=false ;;
      --no-fund|--no-audit|--force|--ignore-scripts|--foreground-scripts) ;;
      --prefix=*)
        if [ "${#bridge_context[@]}" -ne 1 ] || [ "$1" = --prefix= ]; then bridge_supported=0; break; fi
        bridge_context+=("$1")
        ;;
      --prefix)
        if [ "$#" -lt 2 ] || [ "${#bridge_context[@]}" -ne 1 ] || [ -z "$2" ]; then bridge_supported=0; break; fi
        case "$2" in -*) bridge_supported=0; break ;; esac
        bridge_context+=("$1" "$2")
        shift
        ;;
      *) bridge_supported=0 ;;
    esac
    shift
  done
  if [ "$bridge_supported" -ne 1 ] || [ "$bridge_global" -ne 1 ] || [ "$bridge_packages" -ne 1 ]; then
    command npm "${bridge_arguments[@]}"
    return $?
  fi
  if [ "$bridge_dry_run" = auto ]; then
    bridge_mode="$(command npm config get dry-run "${bridge_context[@]}" 2>/dev/null)" || bridge_mode=unknown
  else
    bridge_mode="$bridge_dry_run"
  fi
  if [ "$bridge_mode" = false ]; then
    bridge_root="$(command npm root "${bridge_context[@]}" 2>/dev/null)" || bridge_root=
    case "$bridge_root" in
      /*)
        if [ -e "$bridge_root/@minhspark/codex-mcp-bridge/package.json" ]; then
          bridge_before="$(_codex_bridge_installed_version "$bridge_root")" || bridge_before_verified=0
        fi
        ;;
      *) bridge_before_verified=0 ;;
    esac
  fi
  command npm "${bridge_arguments[@]}" || bridge_install_status=$?
  if [ "$bridge_install_status" -ne 0 ]; then
    printf 'Failed to install: @minhspark/codex-mcp-bridge (exit code %s). See npm error above.\n' "$bridge_install_status" >&2
  elif [ "$bridge_mode" = true ]; then
    printf 'Dry run completed: @minhspark/codex-mcp-bridge (no changes applied).\n'
  elif [ "$bridge_mode" != false ]; then
    printf 'Warning: npm completed, but installation mode could not be verified.\n' >&2
  else
    bridge_after_root="$(command npm root "${bridge_context[@]}" 2>/dev/null)" || bridge_after_root=
    case "$bridge_after_root" in
      /*) bridge_after="$(_codex_bridge_installed_version "$bridge_after_root")" || bridge_after= ;;
    esac
    if [ -z "$bridge_after" ] || [ "$bridge_before_verified" -ne 1 ] || [ "$bridge_after_root" != "$bridge_root" ]; then
      printf 'Warning: npm completed, but the installed @minhspark/codex-mcp-bridge version could not be verified.\n' >&2
    elif [ "$bridge_after_root" = "$bridge_root" ] && [ "$bridge_after" = "$bridge_before" ]; then
      printf 'Already up to date: @minhspark/codex-mcp-bridge v%s\n' "$bridge_after"
    elif [ "$bridge_after_root" = "$bridge_root" ] && [ -n "$bridge_before" ]; then
      printf 'Successfully updated: @minhspark/codex-mcp-bridge v%s -> v%s\n' "$bridge_before" "$bridge_after"
    else
      printf 'Successfully installed: @minhspark/codex-mcp-bridge v%s\n' "$bridge_after"
    fi
  fi
  return "$bridge_install_status"
}
