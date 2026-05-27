import { Controller, Get, Query, UseGuards, Req } from '@nestjs/common';
import { ProductsService } from './products.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { Request } from 'express';

@UseGuards(JwtAuthGuard)
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get('search')
  async search(@Query('q') q: string, @Req() req: Request) {
    const storeId = req.user!.storeId;
    return this.products.search(storeId, q ?? '');
  }
}
