#!/usr/bin/env bash
# Development/test helper for managed Linux machines with Xorg's dummy driver.
set -euo pipefail
display="${DISPLAY:-:99}"
if DISPLAY="$display" xdpyinfo >/dev/null 2>&1; then
  printf 'Display is ready. Run: export DISPLAY=%s\n' "$display"
  exit 0
fi
if [[ "$display" != ':99' ]]; then
  printf 'Existing DISPLAY is unavailable: %s. Check your graphical session.\n' "$display" >&2
  exit 1
fi
command -v Xorg >/dev/null
config="$(mktemp /tmp/i-interview-xorg.XXXXXX.conf)"
cat > "$config" <<'CONFIG'
Section "ServerFlags"
  Option "AutoAddDevices" "false"
  Option "AllowMouseOpenFail" "true"
EndSection
Section "Device"
  Identifier "Dummy"
  Driver "dummy"
  VideoRam 256000
EndSection
Section "Monitor"
  Identifier "Monitor"
  HorizSync 5.0-1000.0
  VertRefresh 5.0-200.0
  Modeline "1440x1000" 120.00 1440 1520 1672 1904 1000 1003 1009 1040
EndSection
Section "Screen"
  Identifier "Screen"
  Device "Dummy"
  Monitor "Monitor"
  DefaultDepth 24
  SubSection "Display"
    Depth 24
    Modes "1440x1000"
  EndSubSection
EndSection
CONFIG
nohup Xorg "$display" -config "$config" -logfile /tmp/i-interview-xorg.log -noreset -nolisten tcp >/tmp/i-interview-display-start.log 2>&1 &
pid=$!
printf '%s\n' "$pid" > /tmp/i-interview-display.pid
for _attempt in {1..30}; do
  if DISPLAY="$display" xdpyinfo >/dev/null 2>&1; then
    printf 'Display is ready. Run: export DISPLAY=%s\n' "$display"
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    printf 'Display startup failed. Read /tmp/i-interview-xorg.log.\n' >&2
    exit 1
  fi
  sleep 0.2
done
printf 'Display startup timed out. Read /tmp/i-interview-xorg.log.\n' >&2
exit 1
