
import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';

export default defineConfig({
  driver: PostgreSqlDriver,

  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? 'wallet_user',
  password: process.env.POSTGRES_PASSWORD ?? 'wallet_password',
  dbName: process.env.POSTGRES_DB ?? 'financial_wallet',

  metadataProvider: ReflectMetadataProvider,

  entities: ['./dist/**/*.entity.js'],
  entitiesTs: ['./src/**/*.entity.ts'],

  migrations: {
    path: './dist/migrations',
    pathTs: './src/migrations',
    glob: '!(*.d).{js,ts}',
    transactional: true,
    allOrNothing: true,
    snapshot: true,
  },

  debug: process.env.NODE_ENV === 'development',
});
