// server.js

require('dotenv').config();
const express = require('express');
const { chromium } = require('playwright');
const {
  login,
  fetchCompanies,
  fetchJobItems,
  fetchDetailUrls,
  scrapeDetail
} = require('./controllers/hrmosController');

const app = express();
const PORT = process.env.PORT || 3000;

async function processScrape({ page, res, url, stopAt }) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Transfer-Encoding': 'chunked' });
  res.write('[');
  let first = true;
  const writeObj = obj => {
    res.write((first ? '' : ',') + JSON.stringify(obj));
    first = false;
  };

  try {
    if (url.includes('/detail') && stopAt === 'details') {
      writeObj(await scrapeDetail(page, url));
      res.end(']');
      return;
    }

    const companies = await fetchCompanies(page);
    if (stopAt === 'companies') {
      companies.forEach(writeObj);
      res.end(']');
      return;
    }

    const target = (() => {
      if (url.includes('/corporates') && !url.includes('/jobs')) return companies;
      if (url.includes('/jobs/') && !url.includes('/detail')) {
        const match = companies.find(c => c.companyJobsUrl === url);
        return match ? [match] : [];
      }
      return null;
    })();

    if (!target || !target.length) {
      res.end(']');
      return;
    }

    const flatJobs = [];
    for (const { companyName, companyJobsUrl } of target) {
      const jobs = await fetchJobItems(page, companyJobsUrl);
      for (const j of jobs) {
        const row = { companyName, title: j.title, url: j.url };
        flatJobs.push(row);
        if (stopAt === 'jobs') writeObj(row);
      }
    }

    if (stopAt === 'jobs') {
      res.end(']');
      return;
    }

    for (const j of flatJobs) {
      const dUrls = await fetchDetailUrls(page, j.url);
      for (const dUrl of dUrls) {
        const dInfo = await scrapeDetail(page, dUrl);
        const { companyName: _, ...rest } = dInfo;
        writeObj({ ...j, ...rest });
      }
    }

    res.end(']');
  } catch (err) {
    console.error('[ERROR]', err);
    res.write((first ? '' : ',') + JSON.stringify({ error: err.message }));
    res.end(']');
  } finally {
    if (page.context()) await page.context().close();
  }
}

app.get('/scrape', async (req, res) => {
  const url = req.query.url || 'https://hrmos.co/agent/corporates';
  const stopAt = req.query.stopAt || 'details';

  const browserState = {
    browser: null,
    async ensureBrowser() {
      if (!this.browser) {
        this.browser = await chromium.launch({ headless: true });
      }
      return this.browser;
    }
  };

  const secrets = {
    email: process.env.HRMOS_EMAIL,
    password: process.env.HRMOS_PASSWORD
  };

  try {
    const { page } = await login(browserState, secrets);
    await processScrape({
      page,
      res,
      url,
      stopAt
    });
  } catch (err) {
    console.error('[ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running at: http://localhost:${PORT}`);
});
