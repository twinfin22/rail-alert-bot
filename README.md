# rail-alert-bot

Read-only Bus, SRT, and KTX availability alerts. It does not contain booking, payment, or cancellation behavior.

## Current commands

After access is granted, Bus accepts `/watch bus txbus FROM_CODE TO_CODE YYYYMMDD` and `/watch bus kobus FROM_CODE FROM_NAME TO_CODE TO_NAME YYYYMMDD`. The Worker validates the future Rail command formats, but blocks SRT/KTX registration until their read-only adapters are wired; this bootstrap does not create watches that cannot be polled. All dates must be today through 30 days away. `/list`, `/stop ID`, and `/delete` are available to every allowed user.

Rail administrators use `/invite`, `/revoke TELEGRAM_USER_ID`, `/users`, `/pause`, `/resume`, and `/status`. Configure the non-secret Worker variable `RAIL_TELEGRAM_USERNAME` before issuing invite links.

## Deploy order

1. Create separate staging and production D1 databases, then replace the two IDs in `wrangler.toml`.
2. Apply migrations: `bunx wrangler d1 migrations apply rail-alert-bot-staging-db --env staging`.
3. Set Worker secrets in each environment: `BUS_TELEGRAM_TOKEN`, `RAIL_TELEGRAM_TOKEN`, `BUS_WEBHOOK_SECRET`, `RAIL_WEBHOOK_SECRET`, and `INTERNAL_API_SECRET`. Set `RAIL_TELEGRAM_USERNAME` as a non-secret Worker variable.
4. Set GitHub environment secrets. Actions receive only `RAIL_WORKER_URL`, `INTERNAL_API_SECRET`, and KTX credentials; Telegram tokens remain Worker-only.
5. Deploy staging and register webhooks with Telegram's `secret_token`. Do not change production webhooks until staging tests are reported and approved.

## Checks

`bun test`, `bun run typecheck`, `bun run check:forbidden`, and `bunx wrangler deploy --dry-run --env staging`.
