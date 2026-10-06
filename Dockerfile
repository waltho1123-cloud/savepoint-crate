# syntax=docker/dockerfile:1
#
# 兩階段建置（比照 wiwi-inout-scan/Dockerfile）：build 階段編譯 TypeScript，runtime 階段只裝 production 依賴。

# ---------- build stage ----------
FROM node:22-alpine AS build
WORKDIR /app

# 坑 (a)：Zeabur 會把服務環境變數（含 NODE_ENV=production）一併注入 build 階段。
# 在 NODE_ENV=production 底下 pnpm 會自動跳過 devDependencies（typescript 等建置工具），
# 導致 `pnpm run build` 找不到 tsc 而失敗，而且本機 docker build 永遠測不出來。
# 這裡把 build stage 的 NODE_ENV 明確蓋成 development，並加 --prod=false 強制連 devDependencies 一起裝。
ENV NODE_ENV=development

# pnpm 版本要與 package.json 的 packageManager 欄位、產生 pnpm-lock.yaml 的版本一致（目前 9.15.9）。
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

# ---------- runtime stage ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# su-exec：入口腳本（scripts/docker-entrypoint.sh）以 root 啟動，只為了把 Volume 目錄修成 appuser 擁有，
# 然後降權；之後的 node 行程不是 root。uid／gid 固定成 10001，換映像版本時 Volume 裡檔案的擁有者才不會變。
RUN apk add --no-cache su-exec \
    && addgroup -S -g 10001 appgroup \
    && adduser -S -D -H -u 10001 -G appgroup -h /app -s /sbin/nologin appuser

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# runtime 只裝 production 依賴（hono、@hono/node-server），不含 typescript、vitest 等工具。
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=true \
    && rm -rf /root/.local/share/pnpm/store /root/.cache

COPY --from=build /app/dist ./dist
# server.ts 從 dist/ 的上一層（/app）讀取 index.html 與 public/assets（WIWI 配色 token 與 Logo）。
COPY index.html ./index.html
COPY public ./public
COPY scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
RUN chmod 755 ./scripts/docker-entrypoint.sh

# 設定頁的資料目錄（settings.json 放這裡）：Zeabur Dashboard → 服務 → 硬碟（Volume）→ 掛載路徑填 /app/data。
# 映像本身不含 data/；沒掛 Volume 時入口腳本仍會建出這個目錄（重新部署後內容會消失）。
ENV DATA_DIR=/app/data

# 坑 (b)：Zeabur 的反向代理固定打容器的 8080，並注入 PORT=8080（不看 EXPOSE）；
# 程式一律讀 process.env.PORT（見 src/env.ts），這裡的 8080 只是本機沒有注入 PORT 時的預設值。
ENV PORT=8080
EXPOSE 8080

# 注意：這裡刻意沒有 USER 指令——入口腳本需要 root 才能修正 Volume 的擁有者，之後它會自己降權成 appuser。
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
