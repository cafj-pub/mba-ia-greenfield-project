import { BullModule } from '@nestjs/bullmq';
import type { DynamicModule } from '@nestjs/common';

// Jobs under this prefix are invisible to the always-running video-worker,
// which consumes the default prefix (phase-03-videos/TD-01 Revision, AMB-3).
export const TEST_QUEUE_PREFIX = 'test';

export function testBullRootModule(
  prefix: string = TEST_QUEUE_PREFIX,
): DynamicModule {
  return BullModule.forRoot({
    connection: {
      host: process.env.REDIS_HOST ?? 'redis',
      port: Number(process.env.REDIS_PORT ?? 6379),
    },
    prefix,
  });
}
