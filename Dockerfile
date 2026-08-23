FROM node:20-bookworm-slim

# pg_dump powers the nightly /api/internal/backup-db job (see docs/SOPS.md).
# Debian bookworm's own repo only ships postgresql-client 15, but the
# production database (Neon) runs Postgres 16 - pg_dump needs to be the same
# or a newer major version than the server it's dumping from, so this pulls
# postgresql-client-16 from the official PGDG apt repo instead. Installed as
# root before the USER node switch below; build-only deps (curl/gnupg) are
# removed again afterward to keep the image lean.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 \
  && apt-get purge -y curl gnupg && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

ENV NODE_ENV=production
ENV PORT=8080

USER node

EXPOSE 8080

CMD ["node", "server/index.js"]
