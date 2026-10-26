import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1792857505035 } from './migrations/1792857505035-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';
import { Video } from '../videos/entities/video.entity';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

const MANAGED_ENUM_TYPES = ['verification_tokens_type_enum', 'video_status'];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1792857505035,
        ],
      },
    );

    await dataSource.initialize();

    // Enum types outlive their tables, so a DB migrated via `migration:run`
    // would make the first migration fail on "type already exists".
    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    for (const type of MANAGED_ENUM_TYPES) {
      await dataSource.query(`DROP TYPE IF EXISTS "${type}" CASCADE`);
    }
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving the videos table missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create all managed tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should revert the last migration and remove the videos table and enum', async () => {
    await dataSource.undoLastMigration();

    const tables = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'videos'`,
    );
    const types = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = 'video_status'`,
    );
    expect(tables).toHaveLength(0);
    expect(types).toHaveLength(0);
  });
});
