FROM node:18-slim
WORKDIR /app

# Playwright 依存ライブラリ
RUN apt-get update && \
    apt-get install -y \
      libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 \
      libxdamage1 libxrandr2 libgbm1 libasound2 libxss1 \
      libgtk-3-0 libpangocairo-1.0-0 && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

# Playwright ブラウザバイナリのインストール
RUN npx playwright install --with-deps

COPY . .

ENV PORT=3000
CMD ["node", "server.js"]
