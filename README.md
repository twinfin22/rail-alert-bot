# rail-alert-bot

Read-only Bus, SRT, and KTX availability alerts. It does not contain booking, payment, or cancellation behavior.

## Deploy order

1. Create separate staging and production D1 databases, then replace the two IDs in `wrangler.toml`.
2. Apply migrations: `bunx wrangler d1 migrations apply rail-alert-bot-staging-db --env staging`.
3. Set Worker secrets in each environment: `BUS_TELEGRAM_TOKEN`, `RAIL_TELEGRAM_TOKEN`, `BUS_WEBHOOK_SECRET`, `RAIL_WEBHOOK_SECRET`, and `INTERNAL_API_SECRET`.
4. Set GitHub environment secrets. Actions receive only `RAIL_WORKER_URL`, `INTERNAL_API_SECRET`, and KTX credentials; Telegram tokens remain Worker-only.
5. Deploy staging and register webhooks with Telegram's `secret_token`. Do not change production webhooks until staging tests are reported and approved.

## Checks

`bun test`, `bun run typecheck`, `bun run check:forbidden`, and `bunx wrangler deploy --dry-run --env staging`.
