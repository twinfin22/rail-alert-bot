FROM oven/bun:1.3.14 AS bun

FROM python:3.12.12-slim-bookworm

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

COPY package.json bun.lock requirements-ktx.txt ./
RUN bun install --frozen-lockfile --production \
  && python -m pip install --no-cache-dir --require-hashes -r requirements-ktx.txt

COPY . .
