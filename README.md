# rail-alert-bot

Read-only Bus, SRT, and KTX availability alerts. It does not contain booking, payment, or cancellation behavior.

## Current commands

After access is granted, Bus accepts `/watch bus txbus FROM_CODE TO_CODE YYYYMMDD` and `/watch bus kobus FROM_CODE FROM_NAME TO_CODE TO_NAME YYYYMMDD`. Rail accepts `/watch srt FROM TO YYYYMMDD HHMM HHMM` and `/watch ktx FROM TO YYYYMMDD HHMM HHMM general|special|all`. All dates must be today through 30 days away. `/list`, `/stop ID`, and `/delete` are available to every allowed user.

Rail administrators use `/invite`, `/revoke TELEGRAM_USER_ID`, `/users`, `/pause`, `/resume`, and `/status`. Configure the non-secret Worker variable `RAIL_TELEGRAM_USERNAME` before issuing invite links.

## Deploy order

1. Create separate staging and production D1 databases, then replace the two IDs in `wrangler.toml`.
2. Apply migrations: `bunx wrangler d1 migrations apply rail-alert-bot-staging-db --env staging`.
3. Set Worker secrets in each environment: `BUS_TELEGRAM_TOKEN`, `RAIL_TELEGRAM_TOKEN`, `BUS_WEBHOOK_SECRET`, `RAIL_WEBHOOK_SECRET`, and `INTERNAL_API_SECRET`. Set `RAIL_TELEGRAM_USERNAME` as a non-secret Worker variable.
4. Create a Railway service from this repository. Its fixed Docker image includes Bun and Python 3.12 with all Bun and KTX Python dependencies installed at build time. Set these Railway service variables: `RAIL_WORKER_URL`, `INTERNAL_API_SECRET`, `KSKILL_KTX_ID`, and `KSKILL_KTX_PASSWORD`. Telegram tokens remain Worker-only. Railway runs one Singapore replica continuously with `bun run poller` and no Railway cron schedule.
5. Keep the GitHub schedules until the Railway production service has recorded normal provider slots. Then remove only the `schedule` triggers from Bus, SRT, KTX, and maintenance, retaining `workflow_dispatch` for emergency runs. Cloudflare's `*/5` cron remains maintenance-only.
6. Deploy staging and register webhooks with Telegram's `secret_token`. Do not change production webhooks until staging tests are reported and approved.
7. After staging deploy, issue exactly one 30-minute first-admin link: `RAIL_WORKER_URL=... INTERNAL_API_SECRET=... bun run bootstrap:admin`. Open it in the Rail bot's private chat. The endpoint refuses use after an administrator exists.

## Checks

`bun test`, `bun run typecheck`, `bun run check:forbidden`, and `bunx wrangler deploy --dry-run --env staging`.
