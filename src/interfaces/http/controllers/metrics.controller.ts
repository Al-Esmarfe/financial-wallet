import { Controller, Get, Header } from '@nestjs/common';
import { registry } from '../../../infrastructure/observability/metrics.js';

/** Exposição Prometheus. Como /health, não exige autenticação (rede interna/scraper). */
@Controller('metrics')
export class MetricsController {
    @Get()
    @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    async scrape(): Promise<string> {
        return registry.render();
    }
}
