import { BullModule } from '@nestjs/bullmq';
import type { DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from '../../config/database.config';
import queueConfig from '../../config/queue.config';

// Shared by AppModule (API) and VideoWorkerModule (worker) so both
// processes connect to the same DB / Redis from a single factory.

export function databaseRootModule(): DynamicModule {
  return TypeOrmModule.forRootAsync({
    imports: [ConfigModule],
    inject: [databaseConfig.KEY],
    useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
      type: 'postgres',
      host: dbConfig.host,
      port: dbConfig.port,
      username: dbConfig.username,
      password: dbConfig.password,
      database: dbConfig.name,
      autoLoadEntities: true,
      synchronize: false,
    }),
  });
}

export function queueRootModule(): DynamicModule {
  return BullModule.forRootAsync({
    inject: [queueConfig.KEY],
    useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
      connection: { host: cfg.host, port: cfg.port },
      prefix: cfg.prefix,
    }),
  });
}
