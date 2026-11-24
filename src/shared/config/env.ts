import 'dotenv/config';
import { z } from 'zod';

const positiveInt = (defaultValue: number) => z.coerce.number().int().positive().default(defaultValue);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    JSON_BODY_LIMIT: z.string().default('5mb'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    WORKER_BATCH_SIZE: positiveInt(50),
    WORKER_CONCURRENCY: positiveInt(10),
    WORKER_POLL_INTERVAL_MS: positiveInt(1000),
    MAX_ATTEMPTS: positiveInt(5),
    RETRY_BASE_MS: positiveInt(1000),
    RETRY_MAX_MS: positiveInt(60000),
    PROVIDER_TIMEOUT_MS: positiveInt(10000),
    SENDING_TIMEOUT_MS: positiveInt(60000),
  })
  .refine((env) => env.RETRY_MAX_MS >= env.RETRY_BASE_MS, {
    message: 'RETRY_MAX_MS deve ser maior ou igual a RETRY_BASE_MS',
    path: ['RETRY_MAX_MS'],
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Variáveis de ambiente inválidas:\n${details}`);
  }
  return result.data;
}

export const env = parseEnv(process.env);
