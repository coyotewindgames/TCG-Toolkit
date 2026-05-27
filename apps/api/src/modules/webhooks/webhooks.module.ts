import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { CheckoutModule } from '../checkout/checkout.module';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [CheckoutModule, InventoryModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
