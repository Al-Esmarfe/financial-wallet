import { IntegrationEvent, IntegrationEventProps } from './integration-event.js';
import { WagerTransactionEventData } from './wager-transaction-event.data.js';

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
    readonly eventType = 'WagerTransactionProcessed';
    readonly version = 1;

    constructor(props: IntegrationEventProps<WagerTransactionEventData>) {
        super(props);
    }
}
