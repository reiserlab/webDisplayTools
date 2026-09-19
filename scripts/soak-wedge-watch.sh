#!/bin/zsh
# Exit when a fault/post-mortem appears in the newest soak log, when the log stops growing (>240 s), or at the deadline.
cd /Users/reiserm/Documents/GitHub/webDisplayTools
DEADLINE=$(date -j -f "%Y-%m-%d %H:%M" "${WATCH_DEADLINE:-2099-01-01 00:00}" +%s)  # export WATCH_DEADLINE="YYYY-MM-DD HH:MM" to bound the watch
last_size=0; last_change=$(date +%s)
while true; do
  now=$(date +%s)
  if (( now > DEADLINE )); then echo "DEADLINE reached $(date)"; exit 0; fi
  f=$(ls -t soak-logs/*.jsonl | head -1)
  sz=$(stat -f %z "$f")
  if (( sz != last_size )); then last_size=$sz; last_change=$now; fi
  if (( now - last_change > 240 )); then echo "STALLED: $f has not grown for 240 s ($(date))"; exit 0; fi
  for g in $(ls -t soak-logs/*.jsonl | head -2); do
    if grep -q '"event":"probe"\|"phase":"quiet"\|"event":"telemetry_dump"\|"event":"crash_report"' "$g"; then
      echo "FAULT EVENT in $g at $(date)"; grep -m3 '"phase":"quiet"\|"event":"telemetry_dump"\|"event":"crash_report"' "$g" | cut -c1-400; exit 0
    fi
  done
  sleep 20
done
