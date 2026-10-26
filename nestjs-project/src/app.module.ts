import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import {
  databaseRootModule,
  queueRootModule,
} from './common/infra/root-modules';
import appConfig from './config/app.config';
import authConfig from './config/auth.config';
import databaseConfig from './config/database.config';
import mailConfig from './config/mail.config';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import swaggerConfig from './config/swagger.config';
import { envValidationSchema } from './config/env.validation';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        authConfig,
        databaseConfig,
        mailConfig,
        queueConfig,
        storageConfig,
        swaggerConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    databaseRootModule(),
    queueRootModule(),
    AuthModule,
    VideosModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
