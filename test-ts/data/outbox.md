## Outbox Pattern in dom-back

This document explains the Outbox pattern implementation used to reliably process side effects (notifications, invoices, transfers) across modules.

### Why Outbox

- **Reliability**: Avoids lost side effects when primary operations succeed but async actions fail.
- **Isolation**: Producers create events in the same transaction; workers consume and retry.
- **Scalability**: Workers filter by event types; processing can scale independently.

## Core domain

```3:21:dom-back/src/shared/outbox/domain/OutboxEvent.ts
export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';

export class OutboxToCreate {
  constructor(
    public readonly aggregateId: string,
    public readonly aggregateType: string,
    public readonly eventType: string,
    public readonly payload: Record<string, any>,
  ) {}

  toCreate(): OutboxEvent {
    return new OutboxEvent(randomUUID(), this.aggregateId, this.aggregateType, this.eventType, this.payload);
  }
}
```

```24:55:dom-back/src/shared/outbox/domain/OutboxEvent.ts
export class OutboxEvent {
  constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly aggregateType: string,
    public readonly eventType: string,
    public readonly payload: Record<string, any>,
    public status: OutboxStatus = 'PENDING',
    public retries: number = 0,
    public readonly createdAt: Date = new Date(),
    public updatedAt: Date = new Date(),
    public dateStartProcessing?: Date,
    public errorMessage?: string,
  ) {}

  markProcessing(): void { /* ... */ }
  markSucceeded(): void { /* ... */ }
  markFailed(error: string): void { /* ... */ }
}
```

Port and in-memory adapter:

```1:11:dom-back/src/shared/outbox/domain/OutboxRepository.ts
export interface OutboxRepository {
  save(event: OutboxEvent, transactionContext?: any): Promise<void>;
  findPendingAndLock(limit: number, eventTypes?: string[]): Promise<OutboxEvent[]>;
  markSucceeded(event: OutboxEvent): Promise<void>;
  markFailed(event: OutboxEvent): Promise<void>;
}
```

```13:39:dom-back/src/shared/outbox/infrastructure/secondary/InMemoryOutboxRepository.ts
async findPendingAndLock(limit: number, eventTypes?: string[]): Promise<OutboxEvent[]> {
  const pendingEvents: OutboxEvent[] = [];
  for (const event of this.events.values()) {
    if (event.status === 'PENDING') {
      if (eventTypes && !eventTypes.includes(event.eventType)) continue;
      pendingEvents.push(event);
      if (pendingEvents.length >= limit) break;
    }
  }
  for (const event of pendingEvents) { event.markProcessing(); this.events.set(event.id, event); }
  return pendingEvents;
}
```

DI wiring:

```6:15:dom-back/src/shared/outbox/infrastructure/primary/OutboxModule.ts
@Module({
  providers: [
    OutboxService,
    { provide: OUTBOX_REPOSITORY, useClass: InMemoryOutboxRepository },
  ],
  exports: [OutboxService, OUTBOX_REPOSITORY],
})
export class OutboxModule {}
```

## Producing events

Use `OutboxService` inside application services after state changes succeed.

```14:29:dom-back/src/shared/outbox/application/OutboxService.ts
@Injectable()
export class OutboxService {
  constructor(@Inject(OUTBOX_REPOSITORY) private readonly outboxRepository: OutboxRepository) {}
  async create(args: CreateOutboxEventArgs): Promise<OutboxEvent> {
    const event = new OutboxToCreate(args.aggregateId, args.aggregateType, args.eventType, args.payload).toCreate();
    await this.outboxRepository.save(event, args.transactionContext);
    return event;
  }
}
```

Example producer: on `payment_intent.succeeded`, enqueue follow-up work.

```167:188:dom-back/src/shared/payment/application/webhook/StripeWebhookService.ts
await this.outboxService.create({
  aggregateId: payment.id.value,
  aggregateType: 'PAYMENT',
  eventType: 'payment.transfer.process',
  payload: { payment: { /* flattened payment data */ } },
});
```

Also enqueues invoice generation events for both sellers and platform:

```202:238:dom-back/src/shared/payment/application/webhook/StripeWebhookService.ts
await this.outboxService.create({ aggregateId: split.id.value, aggregateType: 'PAYMENT_SPLIT', eventType: 'invoice.seller.generate', payload: { /* ... */ } });
await this.outboxService.create({ aggregateId: payment.id.value, aggregateType: 'PAYMENT', eventType: 'invoice.platform.generate', payload: { /* ... */ } });
```

Other producers in the system emit notification events when users interact:

- `notification.post.liked`
- `notification.post.commented`
- `notification.user.followed`
- `notification.chat.message`
- `notification.item.favorited`
- `notification.item.reviewed`

## Consuming events (workers)

Workers periodically poll the outbox, filter by event types, execute, and mark success/failure with retryable semantics.

Payment transfers worker:

```19:40:dom-back/src/order/application/PaymentTransferWorker.ts
@Cron(CronExpression.EVERY_5_SECONDS)
async handleCron() {
  const events = await this.outboxRepository.findPendingAndLock(10, ['payment.transfer.process']);
  for (const event of events) {
    await this.paymentTransferService.processTransfersForPayment(event.payload.payment as Payment);
    event.markSucceeded();
    await this.outboxRepository.save(event);
  }
}
```

Invoice generation worker:

```33:49:dom-back/src/shared/invoice/applications/InvoiceWorker.ts
const events = await this.outboxRepository.findPendingAndLock(20, [
  'invoice.seller.generate',
  'invoice.platform.generate',
]);
// process each event then mark succeeded/failed
```

Notification worker filters by prefix:

```31:49:dom-back/src/notification/applications/NotificationWorker.ts
const events = await this.outboxRepository.findPendingAndLock(50);
const notificationEvents = events.filter((e) => e.eventType.startsWith('notification.'));
for (const event of notificationEvents) { /* notify and markSucceeded */ }
```

## Usage guidelines

- Emit outbox events only after the primary state change is persisted.
- Prefer small, well-typed payloads with identifiers to re-fetch context when needed.
- Use idempotency keys in downstream calls when applicable (e.g., Stripe transfers).
- Workers must guard against concurrent runs and mark events `PROCESSING` via `findPendingAndLock`.
- On failure, call `markFailed(error)` then `save(event)`; workers will pick up on subsequent runs.

## Adding a new outbox-driven process

1. Define event type(s), e.g., `search.index.product.updated`.
2. In the producing use case, call `OutboxService.create({...})` after successful state change.
3. Create a worker that polls `findPendingAndLock(limit, [yourTypes])` and processes events.
4. Ensure idempotency and observability (logs/metrics) in the worker.
5. Write unit tests for producer and worker, including failure paths.
