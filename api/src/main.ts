import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config, mocks } from './config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.corsOrigins, credentials: true, allowedHeaders: ['content-type', 'x-company-id'] });
  app.enableShutdownHooks();
  await app.listen(config.port);
  const log = new Logger('Bootstrap');
  const mocked = Object.entries(mocks).filter(([, v]) => v).map(([k]) => k);
  log.log(`API listening on http://localhost:${config.port}/api (company ${config.companyId})`);
  if (mocked.length) log.warn(`Mocked integrations: ${mocked.join(', ')} (see .env.example to enable real ones)`);
}

void bootstrap();
