# web — Payables dashboard & contractor portal

Next.js 16 (App Router, Turbopack, Cache Components) + Tailwind v4. Talks to the NestJS API described in `../SPEC.md`.

## Run

```bash
pnpm install              # from repo root (workspace)
pnpm dev:web              # or: cd web && pnpm dev   → http://localhost:3000
pnpm --filter web build   # production build
```

Env (`web/.env.local`, see `.env.example`):

| Var | Default | |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000/api` | API base |
| `NEXT_PUBLIC_USE_MOCKS` | `false` | `true` forces the built-in demo data |
| `NEXT_PUBLIC_COMPANY_ID` | — | sent as `x-company-id` if set |

If the API is unreachable (network error/timeout), the client falls back to an in-browser mock backend and shows a **Mock data** badge. The mock backend simulates the agent: uploads go received → extracting → scheduled → paying → paid (or blocked/escalated). Its state lives in `sessionStorage`. File names containing `inject`/`evil` or `tamper` trigger the prompt-injection and tampered-payee scenarios. On an "Awaiting DAO" invoice, the **Simulate DAO approval** button (mock mode only) releases the payment.

The API must allow CORS from `http://localhost:3000`.

## Routes

- `/` landing
- `/dashboard` overview · `/dashboard/invoices` (`?status=`) · `/dashboard/invoices/[id]` · `/dashboard/payees` · `/dashboard/purchase-orders` · `/dashboard/settings`
- `/portal` upload · `/portal/invoices/[id]` live status

## Code map

- `lib/types.ts` — SPEC types · `lib/api.ts` — typed client + mock fallback · `lib/mock-data.ts`, `lib/mock-store.ts` — demo backend · `lib/hooks.ts` — SWR hooks · `lib/format.ts` — USDC base-unit formatting (6 decimals, BigInt)
