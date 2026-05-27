import { Module } from '@nestjs/common';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { OrdersModule } from '../orders/orders.module';
import { SquareClient } from '../../integrations/square/square.client';
import { CloverClient } from '../../integrations/clover/clover.client';

@Module({
  imports: [OrdersModule],
  controllers: [CheckoutController],
  providers: [CheckoutService, SquareClient, CloverClient],
  exports: [CheckoutService, SquareClient, CloverClient],
})
export class CheckoutModule {}
