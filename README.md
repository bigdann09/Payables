# Payables

**The agent pays. The contract decides.**

Payables is an AI accounts-payable agent that pays supplier invoices in USDC on NEAR. The agent reads invoices with NEAR AI and checks them against purchase orders and risk rules. Every payment then goes through an on-chain policy contract:

- Only allowlisted payees can be paid.
- Payments up to 5 USDC are paid automatically, with a daily cap of 15 USDC.
- Anything above the limit needs a Sputnik DAO vote.
- The same invoice can't be paid twice.

A compromised or prompt-injected agent still can't pay anyone outside that policy.

- **Judge mode** (`/try`): attack the live testnet contract from your browser, without a wallet.
- **Dashboard** (`/dashboard`): invoices, payees, purchase orders, DAO votes and flagged addresses.
- **Contractor portal** (`/portal`): where suppliers submit invoices.

See [SPEC.md](SPEC.md) for the full spec and change log.

## Project structure

```
.
├── api/                         NestJS API: HTTP, BullMQ workers (extract → pay → notify), chain sync
│   ├── Dockerfile               production image (build from the repo root)
│   ├── fixtures/                demo invoice PDFs (also used by judge-mode presets)
│   ├── prisma/                  schema, migrations, seed (Postgres)
│   ├── scripts/                 fixture generator
│   ├── src/
│   │   ├── api/                 REST controllers: company, invoices, payees/POs, misc + dev DAO routes
│   │   ├── attack/              judge mode: preset/upload/rogue-agent attacks (never moves funds)
│   │   ├── extraction/          NEAR AI extractor, deterministic rules, prompt-injection detector
│   │   ├── flagged/             flagged addresses (targets of blocked invoices and attacks)
│   │   ├── invoices/            pipeline (extract → rules → schedule → pay) and chain sync
│   │   ├── near/                policy-contract client and an in-memory simulator for offline dev
│   │   ├── notify/              Telegram (grammY) and email (Resend)
│   │   ├── queues/ storage/ prisma/ activity/ common/
│   │   └── main.ts, app.module.ts, config.ts
│   └── test/                    vitest: rules, injection, policy simulator
├── web/                         Next.js 16 (App Router, Tailwind v4)
│   ├── app/
│   │   ├── page.tsx             landing page
│   │   ├── try/                 judge mode
│   │   ├── dashboard/           company dashboard (invoices, payees, POs, settings)
│   │   └── portal/              contractor portal
│   ├── components/              UI kit, status pills, DAO vote card, activity feed
│   └── lib/                     API client (falls back to mock data), NEAR RPC reads, wallet-selector
├── contracts/                   Rust (near-sdk 5)
│   ├── policy/                  policy contract: allowlist, limits, daily cap, DAO escalation
│   ├── mock_usdc/               NEP-141 token for sandbox tests
│   ├── integration-tests/       near-workspaces tests against the real Sputnik DAO wasm
│   ├── res/                     vendored Sputnik DAO v2 binaries
│   └── scripts/deploy-testnet.sh
├── posts/                       social post drafts and images (git-ignored)
├── docker-compose.yml           local Postgres + Redis
└── SPEC.md
```

## Live testnet deployment

| Role | Account |
|---|---|
| Policy contract | `acme.payables.testnet` |
| DAO (council: `payables.testnet`) | `acme-dao.sputnik-v2.testnet` |
| Agent | `payables-agent.testnet` |
| USDC (Circle testnet) | `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` |

## Local development

Requires Node 24, pnpm 10, Docker, and the Rust toolchain (contracts only).

```bash
pnpm install
docker compose up -d                      # Postgres on 55432, Redis on 56379
cp api/.env.example api/.env              # fill in keys; any missing integration falls back to a [MOCK]
cp web/.env.example web/.env.local
pnpm --filter api prisma:deploy && pnpm --filter api prisma:seed
pnpm dev:api                              # http://localhost:4000/api
pnpm dev:web                              # http://localhost:3000
```

Tests:

```bash
pnpm --filter api test                                  # rules, injection, policy simulator
cd contracts && cargo test -p policy           # contract unit tests
cd contracts && cargo test -p integration-tests         # sandbox tests (slow)
```

## Deployment

The API is a single long-running container. Besides HTTP it runs the BullMQ workers and the chain-sync poller, so it needs a host that never sleeps, plus Postgres and Redis. The web app is a standard Next.js deployment.

### API (Docker host with Postgres + Redis, e.g. Railway)

- Build with `api/Dockerfile`, using the repo root as the build context. On start, the container runs `prisma migrate deploy` and then the server.
- Mount a volume at `/data`. Uploaded PDFs are stored in `/data/uploads`, unless R2 is configured.
- Required environment variables:
  - `DATABASE_URL`, `REDIS_URL`
  - `CORS_ORIGINS` (the web URL), `WEB_URL`, `PUBLIC_API_URL`, `FILE_URL_SECRET`
  - NEAR: `AGENT_ACCOUNT_ID`, `AGENT_PRIVATE_KEY`, `OWNER_ACCOUNT_ID`, `OWNER_PRIVATE_KEY`, `POLICY_CONTRACT_ID`, `USDC_CONTRACT_ID`, `DAO_ID`, `NEAR_RPC_URL`
  - `NEAR_AI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- Optional:
  - R2: `R2_*`
  - Email: `RESEND_API_KEY`
  - Judge-mode limits: `ATTACK_PER_IP_PER_10MIN`, `ATTACK_GLOBAL_PER_HOUR`, `ATTACK_UPLOADS_PER_DAY`
- Health check: `GET /api/health`.

### Web (Vercel)

- Set the project's root directory to `web`.
- Set `NEXT_PUBLIC_API_URL` to `https://<api-host>/api`. Optionally set `NEXT_PUBLIC_NEAR_RPC_URL`.

## Judge mode safety

Judge mode never moves funds and never opens DAO proposals. It only submits a payment when the contract is certain to refuse it: the payee isn't allowlisted, or the invoice hash was already used. Both conditions are checked on-chain right before every submission. Attack runs are not stored as invoices; only the targeted addresses are remembered. Rate limits are applied per visitor and globally, and uploaded PDFs, which are read by the AI model, have a daily cap.
