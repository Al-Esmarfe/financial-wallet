import { IntegrationEvent, IntegrationEventProps } from './integration-event.js';
import { WagerTransactionEventData } from './wager-transaction-event.data.js';

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionEventData> {
    readonly eventType = 'WagerTransactionRejected';
    readonly version = 1;

    constructor(props: IntegrationEventProps<WagerTransactionEventData>) {
        super(props);
    }
}
