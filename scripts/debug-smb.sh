#!/bin/bash
# SMB / Time Machine connection debugger

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
read -rp "Synology IP address: " NAS_IP
read -rp "Share name (e.g. TimeMachine): " SHARE
read -rp "Username: " SMB_USER
read -rsp "Password: " SMB_PASS
echo

MOUNT_POINT="/tmp/smb-debug-mount"

pass() { echo "  ✓ $*"; }
fail() { echo "  ✗ $*"; }
info() { echo "  → $*"; }

echo
echo "=== 1. Network reachability ==="
if ping -c 2 -W 1 "$NAS_IP" &>/dev/null; then
  pass "Synology at $NAS_IP is reachable"
else
  fail "Cannot ping $NAS_IP — check IP address or network connection"
  exit 1
fi

echo
echo "=== 2. SMB port (445) ==="
if nc -z -w 3 "$NAS_IP" 445 2>/dev/null; then
  pass "Port 445 is open"
else
  fail "Port 445 is closed — SMB may be disabled or blocked by firewall"
fi

echo
echo "=== 3. NetBIOS/name resolution (139) ==="
if nc -z -w 3 "$NAS_IP" 139 2>/dev/null; then
  pass "Port 139 is open"
else
  info "Port 139 closed (ok if SMB2+ only)"
fi

echo
echo "=== 4. List shares via smbutil ==="
if smbutil view -A "smb://${SMB_USER}:${SMB_PASS}@${NAS_IP}" 2>&1; then
  pass "Share listing succeeded"
else
  fail "Could not list shares — likely wrong credentials or SMB not enabled"
fi

echo
echo "=== 5. Mount share ==="
mkdir -p "$MOUNT_POINT"
if mount_smbfs "//$(python3 -c "import urllib.parse; print(urllib.parse.quote('${SMB_USER}'))" 2>/dev/null || echo "$SMB_USER"):${SMB_PASS}@${NAS_IP}/${SHARE}" "$MOUNT_POINT" 2>&1; then
  pass "Mounted successfully at $MOUNT_POINT"

  echo
  echo "=== 6. Write test ==="
  TEST_FILE="$MOUNT_POINT/.smb-debug-test-$$"
  if touch "$TEST_FILE" 2>&1 && rm "$TEST_FILE"; then
    pass "Write permission confirmed"
  else
    fail "Cannot write to share — check folder permissions for $SMB_USER"
  fi

  echo
  info "Unmounting..."
  umount "$MOUNT_POINT" && pass "Unmounted cleanly"
else
  fail "Mount failed — see error above"
fi

echo
echo "=== Done ==="
