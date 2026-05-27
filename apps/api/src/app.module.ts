import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { DatabaseModule } from './db/database.module';
import { RedisModule } from './common/redis.module';
import { JobsModule } from './jobs/jobs.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProductsModule } from './modules/products/products.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { ScansModule } from './modules/scans/scans.module';
import { OrdersModule } from './modules/orders/orders.module';
import { CheckoutModule } from './modules/checkout/checkout.module';
import { TradeinsModule } from './modules/tradeins/tradeins.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        redact: ['req.headers.authorization', 'req.headers.cookie'],
      },
    }),
    DatabaseModule,
    RedisModule,
    JobsModule,
    AuthModule,
    RealtimeModule,
    ProductsModule,
    InventoryModule,
    ScansModule,
    OrdersModule,
    PricingModule,
    CheckoutModule,
    TradeinsModule,
    WebhooksModule,
    HealthModule,
  ],
})
export class AppModule {}
