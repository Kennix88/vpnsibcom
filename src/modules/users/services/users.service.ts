import { RedisService } from '@core/redis/redis.service'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Cron } from '@nestjs/schedule'
import { CurrencyEnum } from '@shared/enums/currency.enum'
import { UserRolesEnum } from '@shared/enums/user-roles.enum'
import { TelegramInitDataInterface } from '@shared/types/telegram-init-data.interface'
import { isRtl } from '@shared/utils/is-rtl.util'
import { PinoLogger } from 'nestjs-pino'
import { PrismaService } from 'nestjs-prisma'

@Injectable()
export class UsersService {
  private USER_ACTIVITY_PREFIX = 'user_activity:'
  constructor(
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
    private readonly logger: PinoLogger,
    private readonly redis: RedisService,
  ) {}

  public async updateUserActivity(userId: string) {
    const key = `${this.USER_ACTIVITY_PREFIX}${userId}`
    const now = Math.floor(Date.now() / 1000) // Unix timestamp в секундах

    await this.redis
      .multi()
      .set(key, now, 'EX', 86400) // TTL 24 часа
      .zadd('recent_activities', now, userId) // Сортированный набор для быстрого доступа
      .exec()
  }

  @Cron('*/5 * * * *')
  public async syncActivities() {
    const now = Math.floor(Date.now() / 1000)
    const FIVE_MIN_AGO = now - 300
    const ONE_HOUR_AGO = now - 3600

    // 1. Получаем пользователей без активности >5 минут
    const inactiveUsers = await this.redis.zrangebyscore(
      'recent_activities',
      '-inf',
      FIVE_MIN_AGO,
    )

    if (inactiveUsers.length === 0) return

    // 2. Пакетно получаем временные метки
    const pipeline = this.redis.pipeline()
    inactiveUsers.forEach((userId) =>
      pipeline.get(`${this.USER_ACTIVITY_PREFIX}${userId}`),
    )
    const results = await pipeline.exec()

    // 3. Формируем данные для обновления
    const updates = inactiveUsers
      .map((userId, i) => ({
        userId,
        lastActive: parseInt(<string>results[i][1]) * 1000, // Конвертируем в ms
      }))
      .filter((u) => u.lastActive <= Date.now() - 300000) // Точная проверка 5 минут

    // 4. Пакетное обновление в PostgreSQL
    if (updates.length > 0) {
      await this.prismaService.$transaction(
        updates.map((user) =>
          this.prismaService.users.update({
            where: { id: user.userId },
            data: { lastStartedAt: new Date(user.lastActive) },
          }),
        ),
      )
    }

    // 5. Очистка данных старше 1 часа (но оставляем свежие)
    await this.redis.zremrangebyscore('recent_activities', '-inf', ONE_HOUR_AGO)

    // Для каждого удаленного из zset проверяем нужно ли удалять ключ
    const hourOldKeys = updates
      .filter((u) => u.lastActive <= Date.now() - 3600000)
      .map((u) => `${this.USER_ACTIVITY_PREFIX}${u.userId}`)

    if (hourOldKeys.length > 0) {
      await this.redis.del(hourOldKeys)
    }
  }

  public async getUserByTgId(telegramId: string) {
    try {
      return await this.prismaService.users.findUnique({
        where: {
          telegramId,
        },
        include: {
          balance: true,
          giftSubscriptions: true,
          subscriptions: true,
          referrals: true,
          telegramData: true,
          currency: true,
          language: true,
          role: true,
        },
      })
    } catch (e) {
      this.logger.error({
        msg: `Error while getting user by tgId`,
        e,
      })
    }
  }

  public async updateTelegramDataUser(
    telegramId: string,
    initData: TelegramInitDataInterface,
  ) {
    try {
      const user = await this.prismaService.users.findUnique({
        where: {
          telegramId,
        },
        select: {
          telegramDataId: true,
        },
      })
      if (!user) return

      const isRTL = !initData
        ? false
        : isRtl([initData?.user.first_name, initData?.user.last_name])
      await this.prismaService.userTelegramData.update({
        where: {
          id: user.telegramDataId,
        },
        data: {
          isLive: true,
          isRtl: isRTL,
          firstName: initData.user.first_name,
          lastName: initData.user.last_name,
          username: initData.user.username,
          languageCode: initData.user.language_code,
          isPremium: initData.user.is_premium,
          isBot: initData.user.is_bot,
          photoUrl: initData.user.photo_url,
          addedToAttachmentMenu: initData.user.added_to_attachment_menu,
          allowsWriteToPm: initData.user.allows_write_to_pm,
        },
      })
    } catch (e) {
      this.logger.error({
        msg: `Error while updating telegram data user by tgId`,
        e,
      })
    }
  }

  public async createUser({
    telegramId,
    referralKey,
    giftKey,
    initData,
  }: {
    telegramId: string
    referralKey?: string
    giftKey?: string
    initData?: TelegramInitDataInterface
  }) {
    try {
      const user = await this.prismaService.$transaction(async (tx) => {
        const balance = await tx.userBalance.create({
          data: {},
        })
        const isRTL = !initData
          ? false
          : isRtl([initData?.user.first_name, initData?.user.last_name])
        const tdata = await tx.userTelegramData.create({
          data: !initData
            ? {
                firstName: 'ANONIM',
                languageCode: 'ru',
                isLive: true,
              }
            : {
                isLive: true,
                isRtl: isRTL,
                firstName: initData.user.first_name,
                lastName: initData.user.last_name,
                username: initData.user.username,
                languageCode: initData.user.language_code,
                isPremium: initData.user.is_premium,
                isBot: initData.user.is_bot,
                photoUrl: initData.user.photo_url,
                addedToAttachmentMenu: initData.user.added_to_attachment_menu,
                allowsWriteToPm: initData.user.allows_write_to_pm,
              },
        })
        const language = await tx.language.findUnique({
          where: {
            iso6391: initData.user.language_code || 'en',
          },
        })

        // TODO: Add referral logic and gift logic

        return tx.users.create({
          data: {
            telegramId,
            languageId: language.id,
            balanceId: balance.id,
            roleId: UserRolesEnum.USER,
            telegramDataId: tdata.id,
            currencyKey: CurrencyEnum.USD,
            lastStartedAt: new Date(),
          },
        })
      })

      if (!user) {
        this.logger.error({
          msg: `Error while creating user`,
        })
      } else {
        return await this.getUserByTgId(telegramId)
      }
    } catch (e) {
      this.logger.error({
        msg: `Error while creating user`,
        e,
      })
    }
  }
}
