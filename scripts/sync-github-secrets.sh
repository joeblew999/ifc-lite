#!/usr/bin/env bash
# Sync secrets from Doppler → GitHub repo Actions secrets.
#
# Reads the canonical secret list from this script's MAPPING table
# (Doppler key -> GitHub secret name). Idempotent: re-running just
# refreshes whatever has changed.
#
# Required:
#   - doppler CLI (provisioned via mise)
#   - gh CLI authenticated to the target repo
#   - Either `doppler configure` set in the working dir, OR
#     DOPPLER_PROJECT + DOPPLER_CONFIG env vars
#
# Usage:
#   bash scripts/sync-github-secrets.sh                  # uses gh's default repo
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
# Format: "DOPPLER_KEY GITHUB_SECRET"
# Add to this list as new workflows need new secrets.
MAPPING=(
  # Cloudflare deploy (cloudflare-deploy.yml, cloudflare-deploy-mise.yml)
  "CLOUDFLARE_API_TOKEN   CLOUDFLARE_API_TOKEN"
  "CLOUDFLARE_ACCOUNT_ID  CLOUDFLARE_ACCOUNT_ID"

  # Optional: desktop signing (desktop-binaries.yml). Comment out the lines
  # for any cert you don't yet have in Doppler — gh secret set fails on missing
  # source keys, so absence here means "skip".
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

command -v doppler >/dev/null || { echo "doppler not on PATH (run via 'mise exec' or 'mise run secrets:*')" >&2; exit 1; }
command -v gh >/dev/null || { echo "gh CLI not installed" >&2; exit 1; }

# Show what we're about to do.
echo "Syncing $(( ${#MAPPING[@]} )) secrets from Doppler → GitHub..."
echo "  Target repo: $REPO"
proj="${DOPPLER_PROJECT:-$(doppler configure get project --plain 2>/dev/null || echo '(default)')}"
cfg="${DOPPLER_CONFIG:-$(doppler configure get config --plain 2>/dev/null || echo '(default)')}"
echo "  Doppler:     project=$proj config=$cfg"
echo

ok=0
skipped=0
failed=0

for entry in "${MAPPING[@]}"; do
  read -r dkey gkey <<<"$entry"
  if value=$(doppler secrets get "$dkey" --plain 2>/dev/null); then
    if [[ -z "$value" ]]; then
      echo "  ⤬ $dkey → $gkey (empty in Doppler, skipping)"
      skipped=$((skipped+1))
      continue
    fi
    if $DRY_RUN; then
      echo "  ✓ $dkey → $gkey  (dry-run, would set ${#value} bytes)"
    else
      if printf '%s' "$value" | gh secret set "$gkey" --repo "$REPO" --body - >/dev/null 2>&1; then
        echo "  ✓ $dkey → $gkey  (${#value} bytes)"
        ok=$((ok+1))
      else
        echo "  ✗ $dkey → $gkey  (gh secret set failed)"
        failed=$((failed+1))
      fi
    fi
  else
    echo "  ⤬ $dkey not in Doppler (skipping)"
    skipped=$((skipped+1))
  fi
done

echo
echo "Done. ok=$ok skipped=$skipped failed=$failed"
[[ $failed -eq 0 ]]
