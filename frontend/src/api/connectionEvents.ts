/**
 * Amplify realtime connection events, narrowed to what the views need.
 *
 * Amplify v6 reconnects and re-subscribes silently after a socket loss or
 * keep-alive timeout: it never calls the subscription observer's `error`, so a
 * view's own reconnect handling never runs and messages published while the
 * socket was down are lost. The only signal is the Hub `api` channel, which
 * carries `CONNECTION_STATE_CHANGE` and per-subscription `Subscription ack`
 * events. This wrapper exposes those as a small typed stream so views can
 * re-sync, and so tests can inject a fake.
 */
import { Hub } from 'aws-amplify/utils';
import { CONNECTION_STATE_CHANGE } from 'aws-amplify/api';

/** Amplify's start-ack control message name (`CONTROL_MSG.SUBSCRIPTION_ACK`). */
const SUBSCRIPTION_ACK = 'Subscription ack';

export type ApiConnectionEvent =
  /** The shared realtime socket changed state (Amplify `ConnectionState`). */
  | { readonly kind: 'state'; readonly state: string }
  /** A subscription was (re)acknowledged by AppSync. */
  | {
      readonly kind: 'subscriptionAck';
      readonly variables: Record<string, unknown> | undefined;
    };

/** Registers a listener; returns a function that removes it. */
export type ListenApiConnection = (
  listener: (event: ApiConnectionEvent) => void,
) => () => void;

export const listenApiConnection: ListenApiConnection = (listener) =>
  Hub.listen('api', ({ payload }) => {
    const data = payload.data as
      | {
          connectionState?: unknown;
          variables?: Record<string, unknown>;
        }
      | undefined;
    if (payload.event === CONNECTION_STATE_CHANGE) {
      if (typeof data?.connectionState === 'string') {
        listener({ kind: 'state', state: data.connectionState });
      }
    } else if (payload.event === SUBSCRIPTION_ACK) {
      listener({ kind: 'subscriptionAck', variables: data?.variables });
    }
  });
