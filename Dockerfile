FROM node:20-slim

# Install build deps for better-sqlite3 native bindings
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Create runtime directories
RUN mkdir -p logs dkim

# Non-root user for security
RUN useradd -m -u 1001 sender && chown -R sender:sender /app
USER sender

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "vps-sender.js", "--gui"]
