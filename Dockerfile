FROM node:20-slim
WORKDIR /app

# 必要な依存ライブラリをインストール（Playwright 実行に必要）
RUN apt-get update && \
    apt-get install -y \
      libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 \
      libxdamage1 libxrandr2 libgbm1 libasound2 libxss1 \
      libgtk-3-0 libpangocairo-1.0-0 && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

RUN npx playwright install --with-deps

COPY main.js ./
COPY routes/ ./routes/
COPY utils/ ./utils/
COPY controllers/ ./controllers/

EXPOSE 3000
ENV PORT=3000

CMD ["node", "main.js"]
