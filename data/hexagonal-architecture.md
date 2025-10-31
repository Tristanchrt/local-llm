## Hexagonal Architecture in dom-back

This document explains how dom-back implements the Hexagonal (Ports & Adapters) architecture using NestJS. It covers directory layout, dependency rules, ports/adapters, and how to add a new feature.

### Goals

- **Isolation of business logic** in `domain/`
- **Use cases orchestration** in `application/`
- **Framework/IO adapters** in `infrastructure/`
- **Swappable dependencies** via interfaces (ports) and DI tokens
- **Testability** with in-memory adapters and clear seams

## Directory layout per module

Each business capability (chat, post, order, shop, …) is a self-contained module with three layers:

- `domain/`: Entities, value objects, domain services, repository interfaces (ports). No Nest dependencies.
- `application/`: Use cases/services that orchestrate domain logic. Knows ports, not concrete adapters. Minimal Nest usage (e.g., `@Injectable`, tokens).
- `infrastructure/`:
  - `primary/`: Entry points (HTTP controllers/resources, Nest `Module`), DI wiring.
  - `secondary/`: Adapters for ports (DB, external API, queues, in-memory test doubles).

Example of module composition at the app root:

```33:41:dom-back/src/app.module.ts
@Module({
  imports: [
    UserModule,
    PostModule,
    ChatModule,
    StorageModule,
    ShopModule,
    ModerationModule,
    GraphModule,
    NotificationModule,
    InvoiceModule,
    FeedModule,
    EngagementModule,
    TrendingModule,
    RecommendationModule,
    OrderModule,
    PaymentModule,
    // ...
  ],
  // ...
})
```

## Ports and adapters

Ports are interfaces declared in `domain/` (or occasionally `application/`), and adapters live in `infrastructure/secondary/`. Primary adapters (controllers) live in `infrastructure/primary/` and wire tokens to implementations in the Nest module.

- Example port (repository interface):

```8:16:dom-back/src/shared/user/domain/UserRepository.ts
export interface UserRepository {
  save(user: User): Promise<void>;
  findById(id: UserId): Promise<Option<User>>;
  findByIds(
    ids: UserId[],
    pagination: PaginationInput,
  ): Promise<PaginatedResponse<User>>;
}
```

- Example module wiring tokens to adapters and policies:

```22:46:dom-back/src/chat/infrastructure/primary/ChatModule.ts
@Module({
  imports: [
    StorageModule,
    AppNotificationModule,
    ModerationModule,
    AuthModule,
    OutboxModule,
  ],
  controllers: [ChatResource],
  providers: [
    ChatService,
    MessageReadService,
    Reflector,
    ConversationParticipantPolicy,
    SenderMatchesUserPolicy,
    { provide: CHAT_REPOSITORY, useClass: InMemoryChatRepository },
    { provide: MESSAGE_RECEIPT_REPOSITORY, useClass: InMemoryMessageReceiptRepository },
    { provide: READ_POINTER_REPOSITORY, useClass: InMemoryReadPointerRepository },
  ],
  exports: [ChatService],
})
export class ChatModule {}
```

- Another example wiring a port to a concrete implementation and exporting tokens for cross-module use:

```61:69:dom-back/src/post/infrastructure/primary/PostModule.ts
  providers: [
    PostService,
    // ...
    PostFeedProvider,
    { provide: POST_PROVIDER, useExisting: PostFeedProvider },
    { provide: POST_REPOSITORY, useClass: InMemoryPostRepository },
    { provide: FEED_READ_POINTER_REPOSITORY, useClass: InMemoryFeedReadPointerRepository },
  ],
```

## Dependency rules

- `domain` has no dependencies on Nest or infrastructure.
- `application` depends on `domain` and uses DI tokens/ports; it may use Nest decorators for DI.
- `infrastructure` depends on `application` and `domain`, never the other way around.
- Cross-module use cases depend on tokens exported by other modules’ `primary` layer.

## Entry points (Primary adapters)

- REST controllers/resources live in `infrastructure/primary/` and call application services.
- Nest `Module` files are also in `infrastructure/primary/` and are responsible for DI wiring.

## Secondary adapters

- Persistence, external HTTP clients, queues, schedulers, etc., live in `infrastructure/secondary/`.
- In-memory implementations are provided for tests and local dev parity.

## Outbox pattern and workers

Cross-boundary side effects are handled via the outbox pattern to ensure reliability and retriability.

- Create outbox events in application services via the outbox port:

```14:22:dom-back/src/shared/outbox/application/OutboxService.ts
@Injectable()
export class OutboxService {
  constructor(@Inject(OUTBOX_REPOSITORY) private readonly outboxRepository: OutboxRepository) {}

  async create(args: CreateOutboxEventArgs): Promise<OutboxEvent> {
    const event = new OutboxToCreate(
      args.aggregateId,
      args.aggregateType,
      args.eventType,
      args.payload,
    ).toCreate();
    await this.outboxRepository.save(event, args.transactionContext);
    return event;
  }
}
```

- Background workers (cron) consume outbox events and orchestrate side effects:

```19:39:dom-back/src/order/application/PaymentTransferWorker.ts
@Cron(CronExpression.EVERY_5_SECONDS)
async handleCron() {
  // fetch, process, and mark outbox events
  const events = await this.outboxRepository.findPendingAndLock(10, ['payment.transfer.process']);
  for (const event of events) {
    await this.paymentTransferService.processTransfersForPayment(event.payload.payment as Payment);
    event.markSucceeded();
    await this.outboxRepository.save(event);
  }
}
```

## Testing strategy

- Unit tests target `application` and `domain` using in-memory adapters from `infrastructure/secondary/`.
- Integration tests hit HTTP resources (`primary`) and verify module wiring.
- The outbox + worker flow is covered by unit/integration tests where applicable.

## Adding a new feature/module (checklist)

1. Create `domain/` types and ports (e.g., `Foo`, `FooId`, `FooRepository`).
2. Create `application/` use cases/services; depend on ports via DI tokens.
3. Implement adapters in `infrastructure/secondary/` (e.g., in-memory first, then DB/API).
4. Create `infrastructure/primary/<Feature>Module.ts` to wire tokens to adapters, and controllers/resources as entry points.
5. Export any tokens/services needed by other modules.
6. Write unit tests with in-memory adapters; add integration tests for controllers.

## Conventions & tips

- Keep business logic in `domain/` or `application/`, not in controllers.
- Avoid leaking infrastructure types into `domain/`.
- Prefer constructor injection with tokens; avoid direct `new` of adapters in use cases.
- For cross-module collaboration, export tokens from the providing module and import that module where needed.
