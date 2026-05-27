import { Module } from '@nestjs/common';
import { TradeinsService } from './tradeins.service';
import { TradeinsController } from './tradeins.controller';
import { BarcodeService } from './barcode.service';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [InventoryModule],
  controllers: [TradeinsController],
  providers: [TradeinsService, BarcodeService],
  exports: [TradeinsService, BarcodeService],
})
export class TradeinsModule {}
