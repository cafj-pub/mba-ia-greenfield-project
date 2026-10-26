import { Test } from '@nestjs/testing';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';
import { VideoWorkerModule } from './video-worker.module';

describe('VideoWorkerModule', () => {
  // compile() resolves DI without init(), so no BullMQ Worker starts and the
  // Compose video-worker is not competed with.
  it('should compile with DB, queue, storage and media wiring', async () => {
    const module = await Test.createTestingModule({
      imports: [VideoWorkerModule],
    }).compile();

    expect(module.get(VideoProcessingProcessor)).toBeInstanceOf(
      VideoProcessingProcessor,
    );
    expect(module.get(VideoProcessingService)).toBeInstanceOf(
      VideoProcessingService,
    );
    await module.close();
  }, 30000);
});
