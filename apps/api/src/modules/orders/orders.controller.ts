import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import type { Request } from 'express';
import { CreateOrderRequest } from '@tcg/shared';
import type { CreateOrderRequest as CreateOrderRequestT } from '@tcg/shared';
import { OrdersService } from './orders.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

@UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @UsePipes(new ZodValidationPipe(CreateOrderRequest))
  create(@Body() body: CreateOrderRequestT, @Req() req: Request) {
    return this.orders.create({
      storeId: req.user!.storeId,
      locationId: body.locationId,
      registerId: body.registerId,
      customerId: body.customerId,
      userId: req.user!.id,
    });
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() req: Request) {
    return this.orders.findById(req.user!.storeId, id);
  }

  @Post(':id/items')
  addItem(
    @Param('id') id: string,
    @Body() body: { barcode: string },
    @Req() req: Request,
  ) {
    return this.orders.addScannedItem({
      storeId: req.user!.storeId,
      orderId: id,
      barcode: body.barcode,
    });
  }

  @Delete(':id/items/:lineId')
  removeItem(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Req() req: Request,
  ) {
    return this.orders.removeLine({
      storeId: req.user!.storeId,
      orderId: id,
      lineId,
    });
  }
}
