#!/usr/bin/env bash
# Print the age private key for fnox from macOS Keychain.
# Always exits 0 (prints empty if absent) so mise's [env] template
# never fails — CI / fresh machines just get FNOX_AGE_KEY="".
set +e
if command -v security >/dev/null 2>&1; then
  security find-generic-password -s fnox -a age-key -w 2>/dev/null || true
fi
