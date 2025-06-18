// main.js
const express = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright');
const hrmosRouter = require('./hrmos');

const PORT = process.env.PORT || 3000;
const app = express();

// グローバルブラウザインスタンスを共有
const browserState = {
  browser: null,
  async ensureBrowser() {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }
};

app.use(bodyParser.json());

// 各サイトのルータを登録
app.use('/hrmos', hrmosRouter(browserState));

app.listen(PORT, () => console.log(`✅ Server listening on http://localhost:${PORT}`));
