FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs ./
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data CACHE_DIR=/cache PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
