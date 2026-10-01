set -e

root=/data/djonehub
tmp=/data/local/tmp
before=$(df -Pk /data | awk 'NR==2 {print $4 * 1024}')
pending=$(sed -n '1p' "$root/update-pending" 2>/dev/null || true)

for path in \
  "$tmp"/djonehub-update-*.tar.gz \
  "$tmp"/djonehub-webflash-* \
  "$root"/.update-stage-* \
  "$root"/.mac-flash-stage-* \
  "$root"/backup/app-update-* \
  "$root"/backup/mac-flash-* \
  "$root"/backup/webflash-*; do
  test -e "$path" || continue
  if test -n "$pending" && test "$path" = "$pending"; then
    continue
  fi
  rm -rf "$path"
done

rm -f \
  "$root"/log/voice-route.log \
  "$root"/log/voice-route.log.1 \
  "$root"/log/agent.log \
  "$root"/log/startup.log \
  "$root"/bin/qdc507-agent.failed \
  "$root"/bin/qdc507-agent.next

sync
after=$(df -Pk /data | awk 'NR==2 {print $4 * 1024}')
if test "$after" -ge "$before"; then
  freed=$((after-before))
else
  freed=0
fi
printf 'v1 %s %s %s\n' "$before" "$after" "$freed"
