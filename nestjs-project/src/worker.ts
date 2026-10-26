import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { VideoWorkerModule } from './video-worker/video-worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(VideoWorkerModule);
  // Closes the BullMQ worker on SIGTERM/SIGINT (docker compose stop)
  app.enableShutdownHooks();
  Logger.log('Video worker consuming the video-processing queue', 'Worker');
}
void bootstrap();
