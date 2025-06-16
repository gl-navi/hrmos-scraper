FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci
# Install the Playwright browsers needed by @cloudflare/playwright-mcp
RUN npx playwright install

# Copy source
COPY src/ ./src/

# Expose the port (MCP uses WebSockets over HTTP, default 8787 internally)
EXPOSE 8787

# Start the MCP server
CMD ["node", "src/index.js"]
