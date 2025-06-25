//hrmos.js
const express = require('express');
const {
    login,
    fetchCompanies,
    fetchJobItems,
    fetchDetailUrls,
    scrapeDetail,
    processScrape
} = require('../controllers/hrmosController');

module.exports = (browserState, secrets) => {
    const router = express.Router();

    router.get('/', async (req, res) => {
        const url = req.query.url;
        const stopAt = req.query.stopAt || 'details';

        if (!url || !stopAt) {
            return res.status(400).json({ error: 'Missing required query parameters. Required: url, stopAt.' });
        }

        const VALID_STOP_AT_VALUES = new Set(['companies', 'jobs', 'details']);
        if (!VALID_STOP_AT_VALUES.has(stopAt)) {
            return res.status(400).end('stopAt value is invalid. Valid values are: ' + [...VALID_STOP_AT_VALUES].join(', '));
        }

        const { page, context } = await login(browserState, secrets);

        try {
            await processScrape({
                page,
                res,
                url,
                stopAt,
                fetchCompanies,
                fetchJobItems,
                fetchDetailUrls,
                scrapeDetail,
            });
        } finally {
            if (context) await context.close();
        }
    });


    router.post('/', async (req, res) => {
        const {url, stopAt = 'details'} = req.body;

        if (!url || !stopAt) {
            return res.status(400).json({error: 'Missing required parameters. Required: url, stopAt.'});
        }

        const VALID_STOP_AT_VALUES = new Set(['companies', 'jobs', 'details']);
        if (!VALID_STOP_AT_VALUES.has(stopAt)) {
            return res.status(400).end('stopAt value is invalid. Valid values are: ' + [...VALID_STOP_AT_VALUES].join(', '));
        }

        const {page, context} = await login(browserState, secrets);

        try {
            await processScrape({
                page,
                res,
                url,
                stopAt,
                fetchCompanies,
                fetchJobItems,
                fetchDetailUrls,
                scrapeDetail,
            });
        } finally {
            if (context) await context.close();
        }
    });

    return router;
};