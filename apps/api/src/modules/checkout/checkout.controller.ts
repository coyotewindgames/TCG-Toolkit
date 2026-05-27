import {
  Body,
  Controller,
  Param,
  Post,
  Req,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import type { Request } from 'express';
import { CheckoutRequest } from '@tcg/shared';
import type { CheckoutRequest as CheckoutRequestT } from '@tcg/shared';
import { CheckoutService } from './checkout.service';
import { JwtAuthGuard, Roles } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

@UseGuards(JwtAuthGuard)
@Controller('orders/:id/checkout')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post()
  @Roles('clerk', 'manager', 'owner')
  @UsePipes(new ZodValidationPipe(CheckoutRequest))
  start(@Param('id') id: string, @Body() body: CheckoutRequestT, @Req() req: Request) {
    return this.checkout.start(req.user!.storeId, id, body);
  }
}
