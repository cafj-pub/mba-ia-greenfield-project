import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  databaseRootModule,
  queueRootModule,
} from '../common/infra/root-modules';
import databaseConfig from '../config/database.config';
import { workerEnvValidationSchema } from '../config/env.validation';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { MediaService } from './media.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

/** Root module of the standalone video-worker process (src/worker.ts). */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, queueConfig, storageConfig],
      validationSchema: workerEnvValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    databaseRootModule(),
    queueRootModule(),
    // Video's relations reach Channel and User, so their metadata is needed
    TypeOrmModule.forFeature([Video, Channel, User]),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    StorageModule,
  ],
  providers: [MediaService, VideoProcessingService, VideoProcessingProcessor],
})
export class VideoWorkerModule {}
