FROM node:20-bookworm-slim

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

ENV NODE_ENV=production
ENV PORT=8080

USER node

EXPOSE 8080

CMD ["node", "server/index.js"]
