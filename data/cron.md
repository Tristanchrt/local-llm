## Cron and Scheduling in dom-back

This document describes how scheduled jobs are implemented using NestJS `@nestjs/schedule`, where they are configured, and what each cron does.

## Global setup

`ScheduleModule.forRoot()` is initialized at the app level and in some feature modules where workers live.

```33:55:dom-back/src/app.module.ts
@Module({
  imports: [
    // ... other modules ...
    ScheduleModule.forRoot(),
    OutboxModule,
  ],
})
export class AppModule {}
```

Some modules also call `ScheduleModule.forRoot()` locally to ensure cron capability within the module scope:

```17:24:dom-back/src/shared/invoice/infrastructure/primary/InvoiceModule.ts
@Module({
  imports: [
    ScheduleModule.forRoot(),
    OutboxModule,
    OrderModule,
    UserModule,
    VendureModule,
  ],
  // ...
})
export class InvoiceModule {}
```

```17:18:dom-back/src/notification/infrastructure/primary/NotificationModule.ts
@Module({
  imports: [ModerationModule, OutboxModule, ScheduleModule.forRoot()],
  // ...
})
export class NotificationModule {}
```

## Cron jobs

Cron jobs are defined using the `@Cron(CronExpression.XXX)` decorator. Below are the scheduled tasks and their responsibilities.

### Outbox-driven jobs

- Payment transfers:

```19:33:dom-back/src/order/application/PaymentTransferWorker.ts
@Cron(CronExpression.EVERY_5_SECONDS)
async handleCron() {
  const events = await this.outboxRepository.findPendingAndLock(10, ['payment.transfer.process']);
  // processes each event and marks succeeded/failed
}
```

- Invoice generation:

```22:38:dom-back/src/shared/invoice/applications/InvoiceWorker.ts
@Cron(CronExpression.EVERY_10_SECONDS)
async handleCron() {
  const events = await this.outboxRepository.findPendingAndLock(20, ['invoice.seller.generate','invoice.platform.generate']);
  // generates seller/platform invoices and marks events accordingly
}
```

- Notifications dispatch:

```19:33:dom-back/src/notification/applications/NotificationWorker.ts
@Cron(CronExpression.EVERY_10_SECONDS)
async handleCron() {
  const events = await this.outboxRepository.findPendingAndLock(50);
  const notificationEvents = events.filter((e) => e.eventType.startsWith('notification.'));
  // dispatch notifications
}
```

### Feed and recommendations

- Trending score calculation:

```37:41:dom-back/src/trending/application/TrendingService.ts
@Cron(CronExpression.EVERY_HOUR)
async handleCron() {
  await this.calculateTrendingScores();
}
```

- Daily recommendations generation:

```37:41:dom-back/src/recommendation/application/RecommendationService.ts
@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
async handleCron() {
  await this.generateRecommendations();
}
```

- User similarity (for collaborative filtering):

```27:31:dom-back/src/recommendation/application/UserSimilarityService.ts
@Cron(CronExpression.EVERY_DAY_AT_1AM)
async handleCron() {
  await this.calculateAndStoreSimilarities();
}
```

## Patterns and best practices

- Guard concurrent runs with a simple `isProcessing` flag to avoid overlapping execution.
- Use the Outbox pattern for cross-boundary side effects; workers poll with `findPendingAndLock` to mark events `PROCESSING` and ensure idempotency.
- Keep cron bodies thin: delegate to services (`calculateTrendingScores`, `generateRecommendations`, etc.).
- Prefer configuration of schedules via constants or environment variables if you need runtime changes.
- Ensure observability via structured logs around start/end/error of each cron.

## Local development

- Crons run automatically in dev. Adjust frequencies by editing the `CronExpression` constants where needed.
- For outbox-driven crons, you can seed outbox events or trigger producers (e.g., complete a payment) to exercise the flows.
