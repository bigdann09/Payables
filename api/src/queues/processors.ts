import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PipelineService } from '../invoices/pipeline.service';
import { EXTRACT_QUEUE, ExtractJob, NOTIFY_QUEUE, NotifyJob, PAY_QUEUE, PayJob } from './queue-names';

abstract class LoggingWorker extends WorkerHost {
  protected abstract readonly log: Logger;

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error) {
    if (!job) return;
    const final = job.attemptsMade >= (job.opts.attempts ?? 1) || err.name === 'UnrecoverableError';
    this.log.warn(`${job.name} ${job.id} attempt ${job.attemptsMade} failed${final ? ' (final)' : ', will retry'}: ${err.message}`);
  }
}

@Processor(EXTRACT_QUEUE)
export class ExtractProcessor extends LoggingWorker {
  protected readonly log = new Logger('ExtractWorker');
  constructor(private readonly pipeline: PipelineService) {
    super();
  }
  async process(job: Job<ExtractJob>) {
    return this.pipeline.runExtraction(job.data, job.attemptsMade + 1, job.opts.attempts ?? 1);
  }
}

@Processor(PAY_QUEUE)
export class PayProcessor extends LoggingWorker {
  protected readonly log = new Logger('PayWorker');
  constructor(private readonly pipeline: PipelineService) {
    super();
  }
  async process(job: Job<PayJob>) {
    return this.pipeline.runPay(job.data);
  }
}

@Processor(NOTIFY_QUEUE)
export class NotifyProcessor extends LoggingWorker {
  protected readonly log = new Logger('NotifyWorker');
  constructor(private readonly pipeline: PipelineService) {
    super();
  }
  async process(job: Job<NotifyJob>) {
    return this.pipeline.runNotify(job.data);
  }
}
