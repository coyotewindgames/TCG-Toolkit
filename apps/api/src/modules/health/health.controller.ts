import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('healthz')
  health() {
    return { ok: true, uptime: process.uptime() };
  }

  @Get('readyz')
  ready() {
    return { ok: true };
  }
}
