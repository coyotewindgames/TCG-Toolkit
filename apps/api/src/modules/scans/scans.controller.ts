import { Body, Controller, Post, Req, UseGuards, UsePipes } from '@nestjs/common';
import type { Request } from 'express';
import { ScanRequest } from '@tcg/shared';
import type { ScanRequest as ScanRequestT } from '@tcg/shared';
import { ScansService } from './scans.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

@UseGuards(JwtAuthGuard)
@Controller('scans')
export class ScansController {
  constructor(private readonly scans: ScansService) {}

  @Post()
  @UsePipes(new ZodValidationPipe(ScanRequest))
  async scan(@Body() body: ScanRequestT, @Req() req: Request) {
    return this.scans.resolveBarcode({
      storeId: req.user!.storeId,
      barcode: body.barcode,
    });
  }
}
