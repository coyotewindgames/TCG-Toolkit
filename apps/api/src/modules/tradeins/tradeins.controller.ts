import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CreateTradeRequest } from '@tcg/shared';
import type { CreateTradeRequest as CreateTradeRequestT } from '@tcg/shared';
import { TradeinsService } from './tradeins.service';
import { BarcodeService } from './barcode.service';
import { JwtAuthGuard, Roles } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

@UseGuards(JwtAuthGuard)
@Controller('tradeins')
export class TradeinsController {
  constructor(
    private readonly tradeins: TradeinsService,
    private readonly barcode: BarcodeService,
  ) {}

  @Post()
  @UsePipes(new ZodValidationPipe(CreateTradeRequest))
  create(@Body() body: CreateTradeRequestT, @Req() req: Request) {
    return this.tradeins.create({
      storeId: req.user!.storeId,
      userId: req.user!.id,
      body,
    });
  }

  @Post(':id/approve')
  @Roles('manager', 'owner')
  approve(@Param('id') id: string, @Req() req: Request) {
    return this.tradeins.approve({
      storeId: req.user!.storeId,
      tradeId: id,
      userId: req.user!.id,
    });
  }

  @Get('barcode/:token.png')
  @Header('content-type', 'image/png')
  async barcodePng(@Param('token') token: string, @Res() res: Response) {
    const png = await this.barcode.code128(token);
    res.send(png);
  }

  @Get('qr/:token.png')
  @Header('content-type', 'image/png')
  async qrPng(@Param('token') token: string, @Res() res: Response) {
    const png = await this.barcode.qr(token);
    res.send(png);
  }
}
