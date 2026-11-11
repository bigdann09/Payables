import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Read DATABASE_URL directly rather than via prisma's env(), which throws when unset.
// `prisma generate` (run on postinstall) needs no database, and the web app's build
// on Vercel installs the whole workspace without DATABASE_URL. migrate/seed still
// need it and will fail at connect time if it's missing.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
