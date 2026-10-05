#!/bin/sh
# savepoint-crate 容器入口（映像內路徑 /app/scripts/docker-entrypoint.sh；做法參考 wiwi-npd 的入口腳本）。
#
# 權限：以 root 啟動時，只做兩件事——確保資料目錄（DATA_DIR）存在、把整棵樹的擁有者修成 appuser。
# 平台掛上來的 Volume 通常是 root 擁有的空目錄，非 root 的行程寫不進去，設定頁就會回 503，而且健康檢查看不出來。
# 修完用 su-exec 降權、重新執行本檔，之後的 node 行程（PID 1）不是 root。
# 若平台本來就用非 root 啟動（docker run --user、runAsNonRoot），就跳過修正，只檢查目錄可寫。
#
# 資料目錄的任何問題（建不了、改不了擁有者、不可寫）只印警告、**不讓容器退出**：資料目錄只給設定頁用，
# OCR、存檔、環境變數版的 LINE 通知都不該因為 Volume 的問題一起停擺。node 端會再寫一行 error log，
# /healthz 的 dataDirWritable 會是 false，設定頁回 503「請在 Zeabur 掛載 Volume 到 /app/data」。
# （要改成「資料目錄有問題就整個起不來」：把下面的 warn 換成 die。）
#
# 注意：在 Zeabur 上沒有掛 Volume 時，這裡的 mkdir -p 仍然會建出一個「容器內的暫存目錄」，服務能啟動、設定頁也能用，
# 但重新部署後設定會消失。node 端會偵測資料目錄是不是獨立掛載的磁碟（/healthz 的 dataDirMounted）並在 log 提醒。
set -eu

APP_USER=appuser
APP_GROUP=appgroup
DATA_DIR="${DATA_DIR:-/app/data}"

warn() {
  printf '[entrypoint] 警告：%s\n' "$*" >&2
}

# shellcheck disable=SC2317  # 保留給「改成 fail-fast」時使用
die() {
  printf '[entrypoint] 錯誤：%s\n' "$*" >&2
  exit 1
}

if [ "$(id -u)" = "0" ]; then
  if ! mkdir -p "${DATA_DIR}"; then
    warn "無法建立 DATA_DIR（${DATA_DIR}）：設定頁會停用，服務其餘功能照常"
  elif [ -n "$(find "${DATA_DIR}" ! -user "${APP_USER}" 2>/dev/null | head -n 1)" ]; then
    # 整棵樹只要有不屬於 appuser 的項目就修正：第一次掛載時整個修一遍，之後每次啟動只是一次很快的掃描。
    # -h：碰到符號連結時改連結本身、不追到它指向的檔案（Volume 裡的內容不能被拿來騙 root 改別處的擁有者）。
    printf '[entrypoint] 修正 %s 的擁有者為 %s\n' "${DATA_DIR}" "${APP_USER}"
    if ! chown -R -h "${APP_USER}:${APP_GROUP}" "${DATA_DIR}"; then
      warn "無法修正 DATA_DIR（${DATA_DIR}）的擁有者：設定頁可能會因為寫不進去而停用，服務其餘功能照常"
    fi
  fi
  exec su-exec "${APP_USER}:${APP_GROUP}" "$0" "$@"
fi

# ───── 以下以非 root 身分執行 ─────

if [ ! -d "${DATA_DIR}" ] || [ ! -w "${DATA_DIR}" ]; then
  warn "DATA_DIR（${DATA_DIR}）不可寫：請確認 Volume 已掛載到這個路徑，且擁有者是 ${APP_USER}（以 root 啟動時入口腳本會自動修正）。設定頁會停用，服務其餘功能照常"
fi

exec "$@"
