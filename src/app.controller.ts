import { Controller, Get, Inject } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

@Controller()
export class AppController {
  constructor(
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  @Get()
  getHello() {
    return {
      message: 'Financial Wallet API is running!',
    };
  }

  @Get('database-check')
  async databaseCheck() {
    await this.em.getConnection().execute('SELECT 1');

    return {
      status: 'connected',
      database: 'PostgreSQL',
    };
  }
}