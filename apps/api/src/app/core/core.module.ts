import { pinoConfig } from '@core/configs/pino.config'
import { PrismaConnectModule } from '@core/prisma/prisma-connect.module'
import { RedisModule } from '@core/redis/redis.module'
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { IS_DEV_ENV } from '@shared/utils/is-dev.util'
import {
  AcceptLanguageResolver,
  HeaderResolver,
  I18nJsonLoader,
  I18nModule,
  QueryResolver,
} from 'nestjs-i18n'
import { LoggerModule } from 'nestjs-pino'

@Module({
  imports: [
    LoggerModule.forRoot(pinoConfig),
    ConfigModule.forRoot({
      ignoreEnvFile: !IS_DEV_ENV,
      isGlobal: true,
    }),
    I18nModule.forRootAsync({
      useFactory: () => ({
        disableMiddleware: true,
        fallbackLanguage: 'en',
        loaderOptions: {
          path: 'apps/api/src/app/core/i18n/locales',
          watch: true,
          includeSubfolders: true,
        },
        typesOutputPath: 'apps/api/src/app/core/i18n/i18n.type.ts',
      }),
      resolvers: [
        { use: QueryResolver, options: ['lang'] },
        AcceptLanguageResolver,
        new HeaderResolver(['x-lang']),
      ],
      loader: I18nJsonLoader,
    }),
    RedisModule,
    PrismaConnectModule,
  ],
  controllers: [],
  providers: [],
})
export class CoreModule {}
