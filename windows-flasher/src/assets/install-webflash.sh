#!/bin/sh
set -u

# QDC507 transactional WebUSB installer. It deliberately uses only POSIX shell
# and BusyBox applets available on the module.

progress() {
  # ADB shell is not a TTY, so stdout is fully buffered. Mirror the live
  # progress line to stderr (unbuffered) and persist it for reconnect.
  printf 'DJWEBFLASH %s %s %s\n' "$1" "$2" "$3"
  printf 'DJWEBFLASH %s %s %s\n' "$1" "$2" "$3" >&2
  if test -n "${STAGE:-}"; then
    printf 'DJWEBFLASH %s %s %s\n' "$1" "$2" "$3" >> "$STAGE/install.log" || true
  fi
}
fail() { progress failed 0 "$2"; exit "$1"; }

case "${1:-}" in
  /data/local/tmp/djonehub-webflash-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) fail 64 "staging path invalid" ;;
esac

TEST_ROOT=${DJWEBFLASH_TEST_ROOT:-}
path() { printf '%s%s' "$TEST_ROOT" "$1"; }
STAGE=$(path "$1")
PAYLOAD=$STAGE/payload
META=$STAGE/install.meta
DATA=$(path /data/djonehub)
AGENT=$DATA/bin/qdc507-agent
RECOVERY_AGENT=$DATA/bin/qdc507-agent.recovery
INIT=$(path /etc/init.d/djonehub_agent)
LINK=$(path /etc/rc5.d/S99zz_djonehub_agent)
ROOT_RW=0
COMMIT_STARTED=0

restore_root_ro() {
  if test "$ROOT_RW" = 1; then
    mount -o remount,ro / 2>/dev/null || true
    ROOT_RW=0
  fi
}
trap restore_root_ro EXIT HUP INT TERM

progress preflight 5 "checking module identity"
uid=${DJWEBFLASH_TEST_UID:-$(id -u 2>/dev/null)}
test "$uid" = 0 || fail 65 "root identity required"
arch=${DJWEBFLASH_TEST_ARCH:-$(uname -m 2>/dev/null)}
kernel=${DJWEBFLASH_TEST_KERNEL:-$(uname -r 2>/dev/null)}
test "$arch" = armv7l || fail 66 "unsupported architecture"
case "$kernel" in 3.18.44*) ;; *) fail 66 "unsupported kernel" ;; esac

if test -n "${DJWEBFLASH_TEST_USB_ID+x}"; then
  usb_id=$DJWEBFLASH_TEST_USB_ID
else
  gadget=$(path /sys/devices/virtual/android_usb/android0)
  vendor=$(cat "$gadget/idVendor" 2>/dev/null || true)
  product=$(cat "$gadget/idProduct" 2>/dev/null || true)
  usb_id=$(printf '%s:%s' "$vendor" "$product")
fi
usb_id=$(printf '%s' "$usb_id" | tr 'A-F' 'a-f')
test "$usb_id" = "2c7c:0125" || fail 65 "QDC507 USB identity mismatch"

progress preflight 12 "checking active calls and factory service"
if test -n "${DJWEBFLASH_TEST_CALL_STATE+x}"; then
  call_state=$DJWEBFLASH_TEST_CALL_STATE
else
  call_result=$( (sleep 1; printf 'block_check_condition call_state NONE\n'; sleep 1; printf 'quit\n') | timeout -t 8 /usr/bin/qmi_simple_ril_test 2>&1 | tail -n 40)
  case "$call_result" in *TRUE*) call_state=NONE ;; *) call_state=ACTIVE ;; esac
fi
test "$call_state" = NONE || fail 67 "call is active or state is unknown"
factory_pid=${DJWEBFLASH_TEST_FACTORY_PID:-$(pidof ql_manager_server 2>/dev/null)}
case "$factory_pid" in ''|*[!0-9]*) fail 68 "factory service is unavailable" ;; esac

test -f "$META" || fail 70 "install metadata missing"
version=$(sed -n 's/^VERSION=//p' "$META")
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) fail 70 "version metadata invalid" ;;
esac
init_expected=$(sed -n 's/^INIT_SHA256=//p' "$META")
test "${#init_expected}" = 64 || fail 70 "launcher hash metadata invalid"
case "$init_expected" in *[!0-9a-f]*) fail 70 "launcher hash metadata invalid" ;; esac

hash_file() {
  if command -v busybox >/dev/null 2>&1; then busybox sha256sum "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

expected_names="qdc507-agent qdc507_data11_bridge.ko qdc507_aprv3.ko qdc507_voice.ko mavo-pcm-bridge.armv7"
seen=" "
replace_names=" "
required_bytes=0
helper_expected=

target_for() {
  case "$1" in
    qdc507-agent) path /data/djonehub/bin/qdc507-agent ;;
    qdc507_data11_bridge.ko) path /data/djonehub/kernel/qdc507_data11_bridge.ko ;;
    *) path "/data/djonehub/voice-runtime/$1" ;;
  esac
}

while IFS=' ' read -r expected name mode extra; do
  case "$expected" in VERSION=*|INIT_SHA256=*|'') continue ;; esac
  test -z "${extra:-}" || fail 70 "metadata has extra fields"
  case "$name:$mode" in
    qdc507-agent:755|mavo-pcm-bridge.armv7:755|qdc507_data11_bridge.ko:644|qdc507_aprv3.ko:644|qdc507_voice.ko:644) ;;
    *) fail 70 "metadata contains unsupported payload" ;;
  esac
  case "$seen" in *" $name "*) fail 70 "metadata contains duplicate payload" ;; esac
  if test "$name" = mavo-pcm-bridge.armv7; then helper_expected=$expected; fi
  file=$PAYLOAD/$name
  if test -f "$file"; then
    actual=$(hash_file "$file")
    test "$actual" = "$expected" || fail 70 "payload hash mismatch: $name"
    required_bytes=$((required_bytes + $(wc -c < "$file")))
    replace_names="$replace_names$name "
  else
    target=$(target_for "$name")
    test -f "$target" || fail 70 "payload missing: $name"
    actual=$(hash_file "$target")
    test "$actual" = "$expected" || fail 70 "installed payload mismatch: $name"
  fi
  seen="$seen$name "
done < "$META"
for name in $expected_names; do case "$seen" in *" $name "*) ;; *) fail 70 "payload missing from metadata: $name" ;; esac; done

if test -n "${DJWEBFLASH_TEST_FREE_BYTES+x}"; then
  free_bytes=$DJWEBFLASH_TEST_FREE_BYTES
else
  free_blocks=$(df -Pk "$(path /data)" | awk 'NR==2 {print $4}')
  free_bytes=$((free_blocks * 1024))
fi
transaction_margin_bytes=$((128 * 1024))
test "$free_bytes" -ge "$transaction_margin_bytes" || fail 69 "insufficient transaction margin"

progress staging 25 "preparing atomic replacements"
progress probe 35 "checking staged runtime compatibility"
probe_agent=$PAYLOAD/qdc507-agent
test -f "$probe_agent" || probe_agent=$(target_for qdc507-agent)
probe_helper=$PAYLOAD/mavo-pcm-bridge.armv7
test -f "$probe_helper" || probe_helper=$(target_for mavo-pcm-bridge.armv7)
if ! probe_output=$("$probe_agent" --startup-probe runtime 2>&1); then
  fail 72 "staged Agent runtime probe failed"
fi
case "$probe_output" in
  *"启动探针通过: runtime"*) ;;
  *) fail 72 "staged Agent runtime marker missing" ;;
esac
case "$probe_output" in
  *"__VOICE_HELPER_SHA256__$helper_expected"*) ;;
  *) fail 72 "staged Agent PCM helper whitelist mismatch" ;;
esac
"$probe_helper" --check >/dev/null 2>&1 || fail 72 "staged PCM helper check failed"
current_factory=${DJWEBFLASH_TEST_FACTORY_PID:-$(pidof ql_manager_server 2>/dev/null)}
test "$current_factory" = "$factory_pid" || fail 68 "factory service PID changed during staged probe"

stamp=$(date +%s 2>/dev/null || echo 0)
backup=$DATA/backup/webflash-$stamp-$$
mkdir -p "$backup" || fail 71 "cannot create backup"

rollback() {
  progress rollback 85 "restoring previous installation"
  if test "${DJWEBFLASH_TEST_ROLLBACK:-ok}" = fail; then return 1; fi
  if test -z "$TEST_ROOT"; then mount -o remount,rw / 2>/dev/null || return 1; ROOT_RW=1; fi
  if test "$COMMIT_STARTED" = 1; then test -x "$INIT" && "$INIT" stop >/dev/null 2>&1 || true; fi
  for name in $expected_names; do
    case "$replace_names" in *" $name "*) ;; *) continue ;; esac
    target=$(target_for "$name")
    if test "$COMMIT_STARTED" = 1; then
      if ! test -f "$PAYLOAD/$name"; then
        if test -f "$target.webflash-new"; then mv "$target.webflash-new" "$PAYLOAD/$name" || return 1
        elif test -f "$target"; then mv "$target" "$PAYLOAD/$name" || return 1
        fi
      fi
      rm -f "$target" "$target.webflash-new" || return 1
      if test -f "$backup/$name"; then mv "$backup/$name" "$target" || return 1; fi
    elif test -f "$backup/$name"; then
      rm -f "$target" "$target.webflash-new" || return 1
      mv "$backup/$name" "$target" || return 1
    elif test -f "$backup/$name.new"; then
      rm -f "$target" "$target.webflash-new" || return 1
    fi
  done
  if test -f "$backup/djonehub_agent"; then cp -p "$backup/djonehub_agent" "$INIT" || return 1; else rm -f "$INIT" "$LINK" || return 1; fi
  if test -f "$backup/link.target"; then ln -sfn "$(cat "$backup/link.target")" "$LINK" || return 1; else rm -f "$LINK" || return 1; fi
  rm -f "$RECOVERY_AGENT" || return 1
  target=$(target_for qdc507-agent)
  test ! -f "$target" || ln "$target" "$RECOVERY_AGENT" || return 1
  sync
  restore_root_ro
  return 0
}

for name in $expected_names; do
  case "$replace_names" in *" $name "*) ;; *) continue ;; esac
  target=$(target_for "$name")
  if test -e "$target"; then
    mv "$target" "$backup/$name" || { rollback >/dev/null 2>&1 || true; fail 71 "backup failed"; }
  else
    : > "$backup/$name.new"
  fi
done
if test -e "$INIT"; then cp -p "$INIT" "$backup/djonehub_agent" || { rollback >/dev/null 2>&1 || true; fail 71 "init backup failed"; }; else : > "$backup/djonehub_agent.new"; fi
if test -L "$LINK"; then readlink "$LINK" > "$backup/link.target" || { rollback >/dev/null 2>&1 || true; fail 71 "startup link backup failed"; }; else : > "$backup/link.new"; fi

test "${DJWEBFLASH_TEST_COMMIT:-ok}" != fail || { rollback >/dev/null 2>&1 || true; fail 71 "commit injection failure"; }

progress commit 45 "committing verified payload"
COMMIT_STARTED=1
mkdir -p "$DATA/bin" "$DATA/kernel" "$DATA/voice-runtime" "$DATA/log" "$(dirname "$INIT")" "$(dirname "$LINK")" || { rollback || fail 74 "rollback unconfirmed"; fail 71 "target directory creation failed"; }
for name in $expected_names; do
  case "$replace_names" in *" $name "*) ;; *) continue ;; esac
  target=$(target_for "$name")
  mv "$PAYLOAD/$name" "$target.webflash-new" || { rollback || fail 74 "rollback unconfirmed"; fail 71 "move failed"; }
  case "$name" in
    qdc507-agent|mavo-pcm-bridge.armv7) chmod 755 "$target.webflash-new" || { rollback || fail 74 "rollback unconfirmed"; fail 71 "chmod failed"; } ;;
    *) chmod 644 "$target.webflash-new" || { rollback || fail 74 "rollback unconfirmed"; fail 71 "chmod failed"; } ;;
  esac
  mv "$target.webflash-new" "$target" || { rollback || fail 74 "rollback unconfirmed"; fail 71 "atomic rename failed"; }
done
sync

if test -z "$TEST_ROOT"; then
  mount -o remount,rw / || { rollback || fail 74 "rollback unconfirmed"; fail 71 "root remount failed"; }
  ROOT_RW=1
fi
cat > "$INIT.webflash-new" <<'INIT_SCRIPT'
#!/bin/sh
# DJOneHub 双模式启动器：Mac 模式保留原厂 USB，移动模式才启用 DATA11 Agent。
AGENT=/data/djonehub/bin/qdc507-agent
RECOVERY_AGENT=/data/djonehub/bin/qdc507-agent.recovery
DATA_ROOT=/data/djonehub
BRIDGE=/data/djonehub/kernel/qdc507_data11_bridge.ko
NODE=/dev/djonehub_data11
PIDFILE=/run/djonehub-agent.pid
SUPERVISOR_PIDFILE=/run/djonehub-supervisor.pid
STOP_MARKER=/run/djonehub-agent.stop
USB_REBIND_STAMP=/run/djonehub-usb-rebind.uptime
LOGFILE=/data/djonehub/log/agent.log
GADGET=/sys/devices/virtual/android_usb/android0
ENABLE=$GADGET/enable
FUNCTIONS=$GADGET/functions
TRANSPORTS=$GADGET/f_serial/transports
SERIAL_CONNECTED=$GADGET/f_serial/is_connected_flag
STARTUP_LOG=/data/djonehub/log/startup.log
UPDATE_MARKER=/data/djonehub/update-pending
MAC_MODE_MARKER=/data/djonehub/usb-mode-mac

log_startup() {
    mkdir -p /data/djonehub/log
    printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$STARTUP_LOG"
}

log_usb_state() {
    phase=$1
    carrier=$(cat /sys/class/net/ecm0/carrier 2>/dev/null || echo missing)
    operstate=$(cat /sys/class/net/ecm0/operstate 2>/dev/null || echo missing)
    functions=$(cat "$FUNCTIONS" 2>/dev/null || echo missing)
    enabled=$(cat "$ENABLE" 2>/dev/null || echo missing)
    agent_pid=$(sed -n '1s/ .*//p' "$PIDFILE" 2>/dev/null || true)
    factory_pid=$(pidof ql_manager_server 2>/dev/null | tr ' ' ',' || true)
    test -n "$agent_pid" || agent_pid=missing
    test -n "$factory_pid" || factory_pid=missing
    log_startup "usb-state phase=$phase carrier=$carrier operstate=$operstate functions=$functions enabled=$enabled agent_pid=$agent_pid ql_manager_server_pid=$factory_pid"
}

owned_agent() {
    test -s "$PIDFILE" || return 1
    read pid expected_start < "$PIDFILE" || return 1
    case "$pid:$expected_start" in :*|*:|*[!0-9:]*) return 1;; esac
    test "$(cut -d ' ' -f 22 "/proc/$pid/stat" 2>/dev/null)" = "$expected_start" || return 1
    test "$(cat "/proc/$pid/cmdline" 2>/dev/null | tr '\000' '\n' | sed -n '1p')" = "$AGENT"
}

owned_supervisor() {
    test -s "$SUPERVISOR_PIDFILE" || return 1
    read pid expected_start < "$SUPERVISOR_PIDFILE" || return 1
    case "$pid:$expected_start" in :*|*:|*[!0-9:]*) return 1;; esac
    test "$(cut -d ' ' -f 22 "/proc/$pid/stat" 2>/dev/null)" = "$expected_start" || return 1
    argv2=$(cat "/proc/$pid/cmdline" 2>/dev/null | tr '\000' '\n' | sed -n '2p')
    argv3=$(cat "/proc/$pid/cmdline" 2>/dev/null | tr '\000' '\n' | sed -n '3p')
    argv4=$(cat "/proc/$pid/cmdline" 2>/dev/null | tr '\000' '\n' | sed -n '4p')
    case "$argv2:$argv3:$argv4" in
        /etc/init.d/djonehub_agent:supervise:|/bin/sh:/etc/init.d/djonehub_agent:supervise) return 0;;
        *) return 1;;
    esac
}

wait_agent_health() {
    n=0
    while test "$n" -lt 30; do
        if owned_agent && busybox wget -q -T 3 -O - http://127.0.0.1:7575/api/health 2>/dev/null >/dev/null; then
            return 0
        fi
        sleep 0.5
        n=$((n+1))
    done
    return 1
}

confirm_pending_update() {
    test -s "$UPDATE_MARKER" || return 0
    backup=$(sed -n '1p' "$UPDATE_MARKER")
    case "$backup" in
        "$DATA_ROOT"/backup/app-update-*) ;;
        *) log_startup "update-confirmation-invalid-backup backup=$backup"; return 1;;
    esac
    rm -f "$UPDATE_MARKER" || return 1
    if ! rm -rf "$backup"; then
        log_startup "update-confirmed-backup-cleanup-warning backup=$backup"
        return 0
    fi
    log_startup "update-confirmed backup=$backup"
}

stop_owned_agent() {
    owned_agent || return 0
    read pid expected_start < "$PIDFILE"
    kill -TERM "$pid" 2>/dev/null || true
    n=0
    while owned_agent && test "$n" -lt 50; do
        sleep 0.1
        n=$((n+1))
    done
    owned_agent && kill -KILL "$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
}

restore_agent_binary() {
    test -x "$AGENT" && return 0
    test -x "$RECOVERY_AGENT" || return 1
    rm -f "$AGENT"
    ln "$RECOVERY_AGENT" "$AGENT" || return 1
    chmod 755 "$AGENT"
    log_startup agent-binary-restored-from-recovery-link
}

rebind_usb_if_safe() {
    calls=$(busybox wget -q -T 3 -O - http://127.0.0.1:7575/api/calls/status 2>/dev/null) || return 1
    printf '%s' "$calls" | grep -q '"active":null' || return 1
    current=$(cat "$FUNCTIONS" 2>/dev/null || true)
    case ",$current," in
        *,ecm,*) ;;
        *) return 1;;
    esac
    case ",$current," in
        *,serial,*|*,audio,*) return 1;;
    esac
    now=$(cut -d. -f1 /proc/uptime 2>/dev/null)
    last=$(cat "$USB_REBIND_STAMP" 2>/dev/null || echo 0)
    case "$now:$last" in :*|*:|*[!0-9:]*) return 1;; esac
    test $((now-last)) -ge 300 || return 1
    printf '%s\n' "$now" > "$USB_REBIND_STAMP"
    log_usb_state rebind-before
    log_startup "USB software rebind started functions=$current"
    echo 0 > "$ENABLE" || return 1
    sleep 1
    echo 1 > "$ENABLE" || return 1
    log_startup "USB software rebind completed functions=$(cat "$FUNCTIONS" 2>/dev/null)"
    log_usb_state rebind-after
}

supervise_agent() {
    child=
    stop_requested() {
        test -e "$STOP_MARKER"
    }
    terminate_child() {
        test -n "$child" || return 0
        kill -TERM "$child" 2>/dev/null || true
    }
    trap 'touch "$STOP_MARKER"; terminate_child' TERM INT HUP
    rm -f "$STOP_MARKER" "$PIDFILE"
    restart_delay=1
    while ! stop_requested; do
        if ! restore_agent_binary; then
            log_startup "supervisor-agent-binary-missing restart_in=${restart_delay}s"
            sleep "$restart_delay"
            test "$restart_delay" -ge 30 || restart_delay=$((restart_delay*2))
            test "$restart_delay" -le 30 || restart_delay=30
            continue
        fi
        "$AGENT" &
        child=$!
        starttime=$(cut -d ' ' -f 22 "/proc/$child/stat" 2>/dev/null)
        case "$child:$starttime" in
            :*|*:|*[!0-9:]*)
                log_startup invalid-supervised-agent-pid
                sleep "$restart_delay"
                continue
                ;;
        esac
        printf '%s %s\n' "$child" "$starttime" > "$PIDFILE"
        log_startup "supervisor-agent-start pid=$child"
        log_usb_state agent-start
        unhealthy=0
        carrier_down=0
        while kill -0 "$child" 2>/dev/null && ! stop_requested; do
            sleep 10
            kill -0 "$child" 2>/dev/null || break
            if busybox wget -q -T 3 -O - http://127.0.0.1:7575/api/health 2>/dev/null >/dev/null; then
                unhealthy=0
                if test "$(cat /sys/class/net/ecm0/carrier 2>/dev/null)" = 0; then
                    carrier_down=$((carrier_down+1))
                    if test "$carrier_down" -eq 1; then
                        log_usb_state carrier-down
                    fi
                    if test "$carrier_down" -ge 6; then
                        rebind_usb_if_safe || true
                        carrier_down=0
                    fi
                else
                    if test "$carrier_down" -gt 0; then
                        log_usb_state carrier-recovered
                    fi
                    carrier_down=0
                fi
            else
                unhealthy=$((unhealthy+1))
                if test "$unhealthy" -ge 3; then
                    log_startup "supervisor-health-timeout pid=$child failures=$unhealthy"
                    log_usb_state agent-health-timeout
                    terminate_child
                    break
                fi
            fi
        done
        wait "$child" 2>/dev/null
        child_result=$?
        rm -f "$PIDFILE"
        child=
        stop_requested && break
        log_startup "supervisor-agent-exit code=$child_result restart_in=${restart_delay}s"
        log_usb_state agent-exit
        sleep "$restart_delay"
        test "$restart_delay" -ge 30 || restart_delay=$((restart_delay*2))
        test "$restart_delay" -le 30 || restart_delay=30
    done
    rm -f "$PIDFILE" "$SUPERVISOR_PIDFILE"
    log_startup supervisor-stop
}

rollback_pending_update() {
    test -s "$UPDATE_MARKER" || return 1
    backup=$(sed -n '1p' "$UPDATE_MARKER")
    case "$backup" in /data/djonehub/backup/app-update-*) ;; *) return 1;; esac
    test -d "$backup" || return 1
    log_startup "update-rollback-start backup=$backup"
    if owned_agent; then
        read pid expected_start < "$PIDFILE"
        kill -TERM "$pid" 2>/dev/null || true
        sleep 1
    fi
    rm -f "$PIDFILE" "$UPDATE_MARKER"
    for mapping in \
        qdc507-agent:/data/djonehub/bin/qdc507-agent \
        qdc507_data11_bridge.ko:/data/djonehub/kernel/qdc507_data11_bridge.ko \
        qdc507_aprv3.ko:/data/djonehub/voice-runtime/qdc507_aprv3.ko \
        qdc507_voice.ko:/data/djonehub/voice-runtime/qdc507_voice.ko \
        mavo-pcm-bridge.armv7:/data/djonehub/voice-runtime/mavo-pcm-bridge.armv7; do
        name=${mapping%%:*}
        target=${mapping#*:}
        test -f "$backup/$name" || return 1
        mv "$target" "$target.update-failed" 2>/dev/null || true
        mv "$backup/$name" "$target" || return 1
    done
    chmod 755 "$AGENT" /data/djonehub/voice-runtime/mavo-pcm-bridge.armv7
    chmod 644 "$BRIDGE" /data/djonehub/voice-runtime/*.ko
    if owned_supervisor; then
        wait_agent_health || return 1
    else
        nohup "$AGENT" </dev/null >>"$LOGFILE" 2>&1 &
        pid=$!
        starttime=$(cut -d ' ' -f 22 "/proc/$pid/stat" 2>/dev/null)
        case "$pid:$starttime" in :*|*:|*[!0-9:]*) return 1;; esac
        printf '%s %s\n' "$pid" "$starttime" > "$PIDFILE"
        wait_agent_health || return 1
    fi
    log_startup "update-rollback-complete backup=$backup"
}

wait_usb_profile() {
    n=0
    while test "$n" -lt 100; do
        current=$(cat "$FUNCTIONS" 2>/dev/null || true)
        case ",$current," in
            *,ecm,*) return 0 ;;
        esac
        sleep 0.2
        n=$((n+1))
    done
    return 1
}

wait_mobile_profile() {
    n=0
    while test "$n" -lt 25; do
        current=$(cat "$FUNCTIONS" 2>/dev/null || true)
        case ",$current," in
            *,ecm,*)
                case ",$current," in
                    *,audio,*) ;;
                    *) return 0 ;;
                esac
                ;;
        esac
        sleep 0.2
        n=$((n+1))
    done
    # 该固件在部分 iPhone 上也会错误地保持 audio 描述符与
    # is_connected_flag=1，无法用串口标志可靠区分 macOS/iOS。
    # ECM 已就绪但组合未自动收敛时，默认进入移动模式；Mac 完整模式由用户显式切换。
    return 0
}

is_mobile_profile() {
    current=$(cat "$FUNCTIONS" 2>/dev/null || true)
    case ",$current," in
        *,audio,*) return 1 ;;
        *) return 0 ;;
    esac
}

is_explicit_mac_profile() {
    test -f "$MAC_MODE_MARKER"
}

load_data11_bridge() {
    grep -q '^qdc507_data11_bridge ' /proc/modules 2>/dev/null || insmod "$BRIDGE"
    minor=$(awk '$2 == "djonehub_data11" { print $1 }' /proc/misc)
    test -n "$minor" || return 1
    test -c "$NODE" || {
        rm -f "$NODE"
        mknod "$NODE" c 10 "$minor"
    }
    chmod 600 "$NODE"
}

wait_factory_service() {
    n=0
    while test "$n" -lt 450; do
        factory_pid=$(pidof ql_manager_server 2>/dev/null || true)
        if test -n "$factory_pid"; then
            printf '%s\n' "$factory_pid"
            return 0
        fi
        sleep 0.2
        n=$((n+1))
    done
    return 1
}

activate_mobile_functions() {
    if test -f /run/djonehub-webflash-keep-usb; then
        log_startup "webflash-keep-usb skip-rebind functions=$(cat "$FUNCTIONS" 2>/dev/null)"
        return 0
    fi
    original=$(cat "$FUNCTIONS")
    detached=$(echo "$original" | sed 's/^serial,//; s/,serial,/,/; s/,serial$//; s/^serial$//; s/^audio,//; s/,audio,/,/; s/,audio$//; s/^audio$//')
    test "$detached" != "$original" || return 0
    echo 0 >"$ENABLE"
    sleep 1
    # 移动模式同时移除 serial 与 audio；保留 ECM/ADB，且不触碰原厂 DATA1 服务。
    echo tty >"$TRANSPORTS"
    echo "$detached" >"$FUNCTIONS"
    echo 1 >"$ENABLE"
    sleep 2
}

case "${1:-}" in
supervise)
    supervise_agent
    ;;
start)
    if owned_supervisor && wait_agent_health; then
        exit 0
    fi
    touch "$STOP_MARKER"
    stop_owned_agent
    if owned_supervisor; then
        read supervisor_pid supervisor_start < "$SUPERVISOR_PIDFILE"
        kill -TERM "$supervisor_pid" 2>/dev/null || true
        n=0
        while owned_supervisor && test "$n" -lt 50; do sleep 0.1; n=$((n+1)); done
    fi
    rm -f "$PIDFILE" "$SUPERVISOR_PIDFILE" "$STOP_MARKER"
    restore_agent_binary || { log_startup missing-runtime; exit 66; }
    test -f "$BRIDGE" || { log_startup missing-runtime; exit 66; }
    wait_usb_profile || { log_startup no-ecm-profile; exit 67; }
    # 用户显式选择 Mac 模式时保留一次完整 USB 组合。标记在消费后立即删除，
    # 下次重新供电接入 iPhone 时仍会按移动模式启动 Agent。
    if is_explicit_mac_profile; then
        rm -f "$MAC_MODE_MARKER"
        if ! is_mobile_profile; then
            log_startup "mac-pass-through functions=$(cat "$FUNCTIONS") explicit=1"
            exit 0
        fi
    fi
    # 优先等待固件切换到无 audio 的移动组合；若固件保留 audio，则短暂等待后默认进入移动模式。
    if ! is_mobile_profile && ! wait_mobile_profile; then
        log_startup "mac-pass-through functions=$(cat "$FUNCTIONS") serial_connected=$(cat "$SERIAL_CONNECTED" 2>/dev/null)"
        exit 0
    fi
    log_startup "mobile-start functions=$(cat "$FUNCTIONS") serial_connected=$(cat "$SERIAL_CONNECTED" 2>/dev/null)"
    before=$(wait_factory_service) || { log_startup missing-factory-service-after-wait; exit 68; }
    log_startup "factory-service-ready pid=$before functions=$(cat "$FUNCTIONS")"
    activate_mobile_functions || { log_startup activate-mobile-functions-failed; exit 69; }
    test "$(pidof ql_manager_server)" = "$before" || { log_startup factory-service-changed; exit 70; }
    load_data11_bridge || { log_startup load-data11-failed; exit 71; }
    mkdir -p /data/djonehub/log
    setsid /bin/sh /etc/init.d/djonehub_agent supervise </dev/null >>"$LOGFILE" 2>&1 &
    supervisor_pid=$!
    supervisor_start=$(cut -d ' ' -f 22 "/proc/$supervisor_pid/stat" 2>/dev/null)
    case "$supervisor_pid:$supervisor_start" in :*|*:|*[!0-9:]*) log_startup invalid-supervisor-pid; exit 72;; esac
    printf '%s %s\n' "$supervisor_pid" "$supervisor_start" > "$SUPERVISOR_PIDFILE"
    if ! wait_agent_health; then
        rollback_pending_update && exit 0
        log_startup supervised-agent-unhealthy
        exit 73
    fi
    # 每次健康启动后都刷新恢复链接。更新器会用 rename 替换 AGENT；若只在文件缺失时
    # 创建链接，RECOVERY_AGENT 会继续引用旧 inode，并长期多占约 7 MB。
    rm -f "$RECOVERY_AGENT.next"
    if ln "$AGENT" "$RECOVERY_AGENT.next"; then
        # BusyBox mv 在源和目标已经是同一 inode 时会保留 .next；先移除旧名称，
        # 再把临时硬链接原子落到标准路径。
        rm -f "$RECOVERY_AGENT"
        mv -f "$RECOVERY_AGENT.next" "$RECOVERY_AGENT"
    else
        log_startup recovery-link-refresh-failed
    fi
    confirm_pending_update || { log_startup update-confirmation-failed; exit 74; }
    read pid expected_start < "$PIDFILE"
    log_startup "mobile-agent-ready pid=$pid supervisor_pid=$supervisor_pid factory_pid=$before"
    ;;
stop)
    touch "$STOP_MARKER"
    stop_owned_agent
    if owned_supervisor; then
        read supervisor_pid supervisor_start < "$SUPERVISOR_PIDFILE"
        kill -TERM "$supervisor_pid" 2>/dev/null || true
        n=0
        while owned_supervisor && test "$n" -lt 50; do sleep 0.1; n=$((n+1)); done
        owned_supervisor && kill -KILL "$supervisor_pid" 2>/dev/null || true
    fi
    rm -f "$PIDFILE" "$SUPERVISOR_PIDFILE" "$STOP_MARKER"
    ;;
restart)
    "$0" stop && "$0" start
    ;;
status)
    if owned_supervisor && owned_agent; then
        echo mobile-agent
        exit 0
    fi
    if wait_usb_profile && ! is_mobile_profile; then
        echo mac-pass-through
        exit 0
    fi
    exit 1
    ;;
*)
    echo "usage: $0 {start|stop|restart|status}" >&2
    exit 64
    ;;
esac
INIT_SCRIPT
chmod 755 "$INIT.webflash-new" || { rollback || fail 74 "rollback unconfirmed"; fail 71 "init chmod failed"; }
actual_init=$(hash_file "$INIT.webflash-new")
test "$actual_init" = "$init_expected" || { rollback || fail 74 "rollback unconfirmed"; fail 70 "launcher hash mismatch"; }
mv "$INIT.webflash-new" "$INIT" || { rollback || fail 74 "rollback unconfirmed"; fail 71 "init commit failed"; }
ln -sfn ../init.d/djonehub_agent "$LINK" || { rollback || fail 74 "rollback unconfirmed"; fail 71 "startup link failed"; }
restore_root_ro
progress launcher 60 "dual-mode launcher verified and committed"

current_factory=${DJWEBFLASH_TEST_FACTORY_PID:-$(pidof ql_manager_server 2>/dev/null)}
test "$current_factory" = "$factory_pid" || { rollback || fail 74 "rollback unconfirmed"; fail 68 "factory service PID changed"; }

progress rebooting 68 "keeping current USB profile after commit"
progress startup 70 "starting module agent only in mobile USB profile"
if test "${DJWEBFLASH_TEST_STARTUP:-}" = fail; then startup_ok=0
elif test -n "$TEST_ROOT"; then startup_ok=1
else
  functions=$(cat /sys/devices/virtual/android_usb/android0/functions 2>/dev/null || true)
  case ",$functions," in
    *,audio,*|*,serial,*)
      progress mac-pass 75 "Mac USB profile retained; skipping in-session agent start"
      startup_ok=1
      skip_health=1
      ;;
    *)
      mkdir -p /run 2>/dev/null || true
      : > /run/djonehub-webflash-keep-usb
      if "$INIT" start; then startup_ok=1; else startup_ok=0; fi
      rm -f /run/djonehub-webflash-keep-usb
      skip_health=0
      ;;
  esac
fi
if test "$startup_ok" != 1; then rollback || fail 74 "rollback unconfirmed"; fail 72 "agent startup failed"; fi

progress health 90 "checking local agent health"
if test "${DJWEBFLASH_TEST_HEALTH:-}" = fail; then health=
elif test -n "$TEST_ROOT"; then health="{\"ok\":true,\"version\":\"$version\"}"
elif test "${skip_health:-0}" = 1; then health="{\"ok\":true,\"version\":\"$version\"}"
else
  health=
  attempt=0
  while test "$attempt" -lt 12; do
    health=$(busybox wget -q -T 8 -O - http://127.0.0.1:7575/api/health 2>/dev/null || true)
    case "$health" in *'"ok":true'*'"version":"'"$version"'"'*) break ;; esac
    sleep 5
    attempt=$((attempt + 1))
  done
fi
case "$health" in *'"ok":true'*'"version":"'"$version"'"'*) ;; *) rollback || fail 74 "rollback unconfirmed"; fail 73 "agent health check failed" ;; esac
current_factory=${DJWEBFLASH_TEST_FACTORY_PID:-$(pidof ql_manager_server 2>/dev/null)}
test "$current_factory" = "$factory_pid" || { rollback || fail 74 "rollback unconfirmed"; fail 73 "factory service PID changed after startup"; }

while IFS=' ' read -r expected name mode extra; do
  case "$expected" in VERSION=*|INIT_SHA256=*|'') continue ;; esac
  target=$(target_for "$name")
  actual=$(hash_file "$target")
  test "$actual" = "$expected" || { rollback || fail 74 "rollback unconfirmed"; fail 73 "installed payload mismatch: $name"; }
done < "$META"
actual_init=$(hash_file "$INIT")
test "$actual_init" = "$init_expected" || { rollback || fail 74 "rollback unconfirmed"; fail 73 "installed launcher mismatch"; }

rm -f "$RECOVERY_AGENT" || { rollback || fail 74 "rollback unconfirmed"; fail 71 "recovery link cleanup failed"; }
ln "$AGENT" "$RECOVERY_AGENT" || { rollback || fail 74 "rollback unconfirmed"; fail 71 "recovery link creation failed"; }
printf '%s\n' "$version" > "$DATA/version" || { rollback || fail 74 "rollback unconfirmed"; fail 71 "version write failed"; }
sync
# 健康门通过后，旧版本已不再承担本次事务回滚；删除事务备份，避免每次
# WebUSB 升级永久多占一份 Agent。recovery 是当前 Agent 的硬链接，不额外占空间。
rm -rf "$backup" 2>/dev/null || true
progress complete 100 "module version $version installed"
exit 0
