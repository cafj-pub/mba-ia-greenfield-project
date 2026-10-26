import type { ValidationResult } from 'joi';
import {
  envValidationSchema,
  workerEnvValidationSchema,
} from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access-key',
  S3_SECRET_KEY: 'secret-key',
};

const validate = (
  env: Record<string, string>,
): ValidationResult<Record<string, unknown>> =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

// Narrows Joi's result union — its error branch types `value` as any
const validValue = (env: Record<string, string>): Record<string, unknown> => {
  const result = validate(env);
  if (result.error) throw result.error;
  return result.value;
};

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    expect(validValue({}).SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue', () => {
  it.each(['S3_ACCESS_KEY', 'S3_SECRET_KEY'])(
    'should reject a missing %s',
    (key) => {
      const env: Record<string, string | undefined> = { ...requiredEnv };
      delete env[key];
      const { error } = envValidationSchema.validate(env, {
        allowUnknown: true,
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should reject a non-URI S3_ENDPOINT', () => {
    const { error } = validate({ S3_ENDPOINT: 'not a uri' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });

  it('should apply Compose-service defaults for storage and queue', () => {
    expect(validValue({})).toMatchObject({
      S3_ENDPOINT: 'http://minio:9000',
      S3_BUCKET: 'streamtube-videos',
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      QUEUE_PREFIX: 'bull',
    });
  });
});

describe('workerEnvValidationSchema', () => {
  it('should not require JWT secrets but still require storage credentials', () => {
    const env: Record<string, string> = { ...requiredEnv };
    delete env.JWT_SECRET;
    delete env.JWT_REFRESH_SECRET;

    expect(
      workerEnvValidationSchema.validate(env, { allowUnknown: true }).error,
    ).toBeUndefined();

    delete env.S3_SECRET_KEY;
    expect(
      workerEnvValidationSchema.validate(env, { allowUnknown: true }).error
        ?.message,
    ).toContain('S3_SECRET_KEY');
  });
});
