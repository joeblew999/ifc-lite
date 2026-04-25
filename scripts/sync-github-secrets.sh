#!/usr/bin/env bash
# Sync secrets from fnox → GitHub repo Actions secrets.
#
# fnox reads from macOS Keychain (or whatever providers are configured
# in ~/.config/fnox/config.toml + project fnox.toml). Idempotent: re-
# running just refreshes whatever changed in the source.
#
# Required:
#   - fnox CLI (provisioned via mise)
#   - gh CLI authenticated to the target repo
#   - Secrets present in fnox (e.g. via `fnox set KEY --global`)
#
# Usage:
#   bash scripts/sync-github-secrets.sh                  # default repo
#   bash scripts/sync-github-secrets.sh --repo owner/r   # explicit
#   bash scripts/sync-github-secrets.sh --dry-run        # show plan only
set -euo pipefail

# Default to the fork (joeblew999) — `gh` resolves to upstream (louistrue) when
# a fork relationship exists, which is wrong for our workflows. Override with
# --repo if you actually want to target a different repo.
REPO="${GITHUB_REPO:-joeblew999/ifc-lite}"
DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help)
      sed -n '1,/^set -/p' "$0" | sed 's/^# \{0,1\}//' | head -n -1
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ---- canonical secret mapping --------------------------------------------
# Format: "FNOX_KEY GITHUB_SECRET"
# Add to this list as new workflows need new secrets.
MAPPING=(
  # Cloudflare deploy (cloudflare-deploy-mise.yml)
  "CLOUDFLARE_API_TOKEN   CLOUDFLARE_API_TOKEN"
  "CLOUDFLARE_ACCOUNT_ID  CLOUDFLARE_ACCOUNT_ID"

  # Optional: desktop signing (desktop-binaries.yml). Uncomment when present
  # in fnox (e.g. `fnox set APPLE_CERTIFICATE --global`).
  # "APPLE_CERTIFICATE              APPLE_CERTIFICATE"
  # "APPLE_CERTIFICATE_PASSWORD     APPLE_CERTIFICATE_PASSWORD"
  # "APPLE_SIGNING_IDENTITY         APPLE_SIGNING_IDENTITY"
  # "APPLE_ID                       APPLE_ID"
  # "APPLE_PASSWORD                 APPLE_PASSWORD"
  # "APPLE_TEAM_ID                  APPLE_TEAM_ID"
  # "TAURI_SIGNING_PRIVATE_KEY      TAURI_SIGNING_PRIVATE_KEY"
  # "TAURI_SIGNING_PRIVATE_KEY_PASSWORD TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
)
# ---------------------------------------------------------------------------

command -v fnox >/dev/null || { echo "fnox not on PATH (run via 'mise exec' or 'mise run secrets:*')" >&2; exit 1; }
command -v gh   >/dev/null || { echo "gh CLI not installed" >&2; exit 1; }

# Show what we're about to do.
echo "Syncing $(( ${#MAPPING[@]} )) secrets from fnox → GitHub..."
echo "  Target repo: $REPO"
echo "  fnox source: ~/.config/fnox/config.toml + project fnox.toml (if any)"
echo

ok=0
skipped=0
failed=0

for entry in "${MAPPING[@]}"; do
  read -r fkey gkey <<<"$entry"
  if value=$(fnox get "$fkey" 2>/dev/null); then
    if [[ -z "$value" ]]; then
      echo "  ⤬ $fkey → $gkey (empty in fnox, skipping)"
      skipped=$((skipped+1))
      continue
    fi
    if $DRY_RUN; then
      echo "  ✓ $fkey → $gkey  (dry-run, would set ${#value} bytes)"
    else
      if printf '%s' "$value" | gh secret set "$gkey" --repo "$REPO" --body - >/dev/null 2>&1; then
        echo "  ✓ $fkey → $gkey  (${#value} bytes)"
        ok=$((ok+1))
      else
        echo "  ✗ $fkey → $gkey  (gh secret set failed)"
        failed=$((failed+1))
      fi
    fi
  else
    echo "  ⤬ $fkey not in fnox (skipping)"
    skipped=$((skipped+1))
  fi
done

echo
echo "Done. ok=$ok skipped=$skipped failed=$failed"
[[ $failed -eq 0 ]]
