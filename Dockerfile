# Node.js Lightweight Production Base
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies needed for native modules (if any)
RUN apk add --no-cache python3 make g++

# Copy package specifications
COPY package*.json ./

# Install production dependencies
RUN npm install --production

# Copy project files
COPY . .

# Expose HTTP & PeerJS signaling port
EXPOSE 8080

# Environment Defaults
ENV NODE_ENV=production \
    PORT=8080

# Start server
CMD ["node", "server.js"]
