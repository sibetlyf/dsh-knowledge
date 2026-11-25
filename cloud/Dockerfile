FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY lib ./lib
COPY cloud ./cloud

RUN mkdir -p /data && chown -R node:node /app /data
USER node
ENV TEAM_DATA_DIR=/data \
    TEAM_HOST=0.0.0.0 \
    TEAM_PORT=8787 \
    NODE_ENV=production
EXPOSE 8787
VOLUME ["/data"]
CMD ["node", "cloud/server.mjs"]
