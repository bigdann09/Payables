import 'dotenv/config';

function str(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v.trim() !== '' ? v.trim() : fallback;
}

/** Central, typed view of the environment. Missing optional groups switch the matching module to a mock. */
export const config = {
  port: Number(str('PORT', '4000')),
  corsOrigins: (str('CORS_ORIGINS', 'http://localhost:3000') as string).split(',').map((s) => s.trim()),
  publicApiUrl: str('PUBLIC_API_URL', 'http://localhost:4000') as string,
  webUrl: str('WEB_URL', 'http://localhost:3000') as string,
  databaseUrl: str('DATABASE_URL', 'postgresql://payables:payables@localhost:5432/payables') as string,
  redisUrl: str('REDIS_URL', 'redis://localhost:6379') as string,
  companyId: str('COMPANY_ID', 'acme') as string,
  /** If set, `pay` jobs run at min(dueDate, now + N seconds). Demo convenience. */
  payDelayOverrideSeconds: str('PAY_DELAY_OVERRIDE_SECONDS') ? Number(str('PAY_DELAY_OVERRIDE_SECONDS')) : undefined,
  chainSyncIntervalMs: Number(str('CHAIN_SYNC_INTERVAL_MS', '15000')),
  signingSecret: str('FILE_URL_SECRET', 'dev-only-insecure-secret') as string,
  localStorageDir: str('LOCAL_STORAGE_DIR', '.data/uploads') as string,

  r2: {
    accountId: str('R2_ACCOUNT_ID'),
    endpoint: str('R2_ENDPOINT'),
    accessKeyId: str('R2_ACCESS_KEY_ID'),
    secretAccessKey: str('R2_SECRET_ACCESS_KEY'),
    bucket: str('R2_BUCKET'),
  },

  nearAi: {
    apiKey: str('NEAR_AI_API_KEY'),
    baseUrl: str('NEAR_AI_BASE_URL', 'https://cloud-api.near.ai/v1') as string,
    model: str('NEAR_AI_MODEL', 'anthropic/claude-haiku-5-5') as string,
  },

  near: {
    networkId: str('NEAR_NETWORK_ID', 'testnet') as string,
    rpcUrl: str('NEAR_RPC_URL', 'https://rpc.testnet.fastnear.com') as string,
    policyContractId: str('POLICY_CONTRACT_ID', 'acme.payables.testnet') as string,
    usdcContractId: str('USDC_CONTRACT_ID', 'usdc.payables.testnet') as string,
    daoId: str('DAO_ID', 'acme-dao.sputnik-v2.testnet') as string,
    agentAccountId: str('AGENT_ACCOUNT_ID', 'agent.payables.testnet') as string,
    agentPrivateKey: str('AGENT_PRIVATE_KEY'),
    ownerAccountId: str('OWNER_ACCOUNT_ID'),
    ownerPrivateKey: str('OWNER_PRIVATE_KEY'),
    /** Starting USDC treasury of the simulated chain (base units). */
    simTreasury: str('SIM_TREASURY_BALANCE', '15000000') as string,
    explorerTxUrl: str('NEAR_EXPLORER_TX_URL', 'https://testnet.nearblocks.io/txns/') as string,
    astroDaoUrl: str('ASTRODAO_URL', 'https://testnet.app.astrodao.com') as string,
  },

  telegram: {
    botToken: str('TELEGRAM_BOT_TOKEN'),
    defaultChatId: str('TELEGRAM_CHAT_ID'),
  },

  email: {
    resendApiKey: str('RESEND_API_KEY'),
    from: str('EMAIL_FROM', 'Payables <payables@example.com>') as string,
  },
};

export const mocks = {
  storage: !(config.r2.bucket && config.r2.accessKeyId && config.r2.secretAccessKey && (config.r2.endpoint || config.r2.accountId)),
  extractor: !config.nearAi.apiKey,
  /** Chain is real only if RPC + agent key are present. Owner key is required separately for owner calls. */
  chain: !config.near.agentPrivateKey,
  telegram: !config.telegram.botToken,
  email: !config.email.resendApiKey,
};
