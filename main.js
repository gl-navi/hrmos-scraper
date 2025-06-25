
//main.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { chromium } = require('playwright');
const hrmosRouter = require('./routes/hrmos');
const { getSecrets } = require('./utils/aws_helper');

const PORT = process.env.PORT || 3000;
const app = express();


// This object manages the Playwright browser instance to reuse it across requests.
// It launches the browser only once, and keeps it alive until the server stops.
const browserState = {
    browser: null,
    async ensureBrowser() {
        if (!this.browser) {
            this.browser = await chromium.launch({ headless: true });
        }
        return this.browser;
    },
};

/**
 * Starts the Express server.
 *
 * 1. Loads secrets (email/password) from AWS Secrets Manager once at startup.
 * 2. Sets up middleware for JSON parsing.
 * 3. Mounts the HRMOS scraping router, injecting browser state and secrets into it.
 * 4. Adds a 404 handler for any unknown routes.
 * 5. Starts listening on the configured port.
 *
 * If anything goes wrong during startup, it logs the error and stops the process.
 */
async function startServer() {
    try {
        // Get credentials securely from AWS Secrets Manager
        const secrets = await getSecrets();
        if (!secrets || !secrets.email || !secrets.password) {
            throw new Error('Failed to load email/password secrets from AWS');
        }

        // Use bodyParser middleware to parse JSON bodies on incoming requests
        app.use(bodyParser.json());

        // Mount the HRMOS router at /hrmos, passing the browser state and secrets
        app.use('/hrmos', hrmosRouter(browserState, secrets));

        // Catch-all handler for any routes not defined above
        app.use((req, res) => {
            console.log(`Invalid route request ${req.method} ${req.originalUrl}`);
            res.status(404).json({ error: `Route ${req.originalUrl} not available.` });
        });

        // Start the server and listen on the port
        app.listen(PORT, () => {
            const envHost = process.env.HOST || 'localhost';
            console.log(`✅ Server listening on http://${envHost}:${PORT}`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);  // Exit if startup fails as there is nothing to serve without secrets or browser
    }
}

// Run the server and handle any uncaught errors
startServer().catch((err) => {
    console.error('Error starting server:', err);
    process.exit(1);
});