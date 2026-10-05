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

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# runtime 只裝 production 依賴（hono、@hono/node-server），不含 typescript、vitest 等工具。
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=true \
    && rm -rf /root/.local/share/pnpm/store /root/.cache

COPY --from=build /app/dist ./dist
# server.ts 從 dist/ 的上一層（/app）讀取 index.html。
COPY index.html ./index.html

RUN addgroup -S appgroup && adduser -S -G appgroup appuser
USER appuser

# 坑 (b)：Zeabur 的反向代理固定打容器的 8080，並注入 PORT=8080（不看 EXPOSE）；
# 程式一律讀 process.env.PORT（見 src/env.ts），這裡的 8080 只是本機沒有注入 PORT 時的預設值。
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/server.js"]
