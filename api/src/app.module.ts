import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ActivityService } from './activity/activity.service';
import { AttackController } from './attack/attack.controller';
import { AttackService } from './attack/attack.service';
import { FlaggedService } from './flagged/flagged.service';
import { CompanyController } from './api/company.controller';
import { InvoicesController } from './api/invoices.controller';
import { MiscController } from './api/misc.controller';
import { PayeesController } from './api/payees.controller';
import { config } from './config';
import { ExtractorService } from './extraction/extractor.service';
import { ChainSyncService } from './invoices/chain-sync.service';
import { PipelineService } from './invoices/pipeline.service';
import { NearService } from './near/near.service';
import { NotifierService } from './notify/notifier.service';
import { PrismaModule } from './prisma/prisma.module';
import { ExtractProcessor, NotifyProcessor, PayProcessor } from './queues/processors';
import { EXTRACT_QUEUE, NOTIFY_QUEUE, PAY_QUEUE } from './queues/queue-names';
import { SamplesController } from './samples/samples.controller';
import { SamplesService } from './samples/samples.service';
import { StorageService } from './storage/storage.service';

const keep = { removeOnComplete: { count: 500 }, removeOnFail: { count: 1000 } };

@Module({
  imports: [
    PrismaModule,
    BullModule.forRoot({ connection: { url: config.redisUrl, maxRetriesPerRequest: null } }),
    BullModule.registerQueue(
      { name: EXTRACT_QUEUE, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, ...keep } },
      { name: PAY_QUEUE, defaultJobOptions: { attempts: 4, backoff: { type: 'exponential', delay: 5000 }, ...keep } },
      { name: NOTIFY_QUEUE, defaultJobOptions: { attempts: 6, backoff: { type: 'exponential', delay: 3000 }, ...keep } },
    ),
  ],
  controllers: [CompanyController, InvoicesController, PayeesController, MiscController, AttackController, SamplesController],
  providers: [
    ActivityService,
    FlaggedService,
    AttackService,
    SamplesService,
    StorageService,
    ExtractorService,
    NearService,
    NotifierService,
    PipelineService,
    ChainSyncService,
    ExtractProcessor,
    PayProcessor,
    NotifyProcessor,
  ],
})
export class AppModule {}
