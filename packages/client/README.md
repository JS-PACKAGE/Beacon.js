# @js-package/beacon-client

Dependency-free ESM WebSocket client for Beacon protocol **3**. Node 22+ supplies a global WebSocket; browsers use their native WebSocket. Older hosts can inject a compatible `WebSocket` constructor. There are no `ws`, Node built-in, or service runtime imports.

```ts
import { BeaconClient } from '@js-package/beacon-client';

const client = new BeaconClient({
  url: 'wss://lobby.example/ws',
  token: async () => obtainAccessToken(),
});
client.on('match_proposal', proposal => {
  console.log(proposal.proposalId, proposal.deadline);
});
await client.connect();
await client.selectGame('my-game');
const response = await client.listFriends();
const friends = response.get('friends'); // concrete, discriminated payload
console.log(friends?.friends, client.state.friends);
```

`state` normalizes friends, party, invitations, blocks, queue, proposal and private match results. Reconnect authentication receives fresh snapshots; pushes update the same state. `state.results` is the pending inbox: results remain until explicitly acknowledged with `ackMatchResult(resultId)`. Paginated history returns all records in the typed request response, but only unacknowledged records enter the pending map; acknowledged history cannot resurrect notifications. Use typed named events or discriminate the `message` event by `type`. Invalid or unknown wire messages close the connection rather than claiming a typed payload.

Every convenience command accepts `RequestOptions` as its last argument. `request(command, options)` supports exact request IDs, deadlines, explicit retry-on-reconnect and `AbortSignal`. Cancellation stops **local waiting only**: a command already sent may have committed, so reconcile with `syncState()` instead of assuming rollback. Cancellation, completion, disconnect and deadlines remove their pending timer and abort listener. Automatic retries are opt-in; never retry an uncertain mutation with a new ID.

Convenience methods cover room discovery/membership/moderation, friends/blocks, party creation/invitations/leader transfer/kick/disband/whole-party room joining, invitation inbox/decline/revoke, queue join/leave and proposal accept/decline, result history/acknowledgement, room/party chat/history/mute/report, and auth refresh/state sync. Queue input exposes only basic/advanced matching and role preferences, not untrusted skill or RTT.

WSS is required by default. `allowInsecure: true` is solely an explicit local-development opt-in. Call `disconnect()` when finished. Tokens stay in protocol auth frames and never belong in the URL.

The `./schema` export provides generated `clientSchema` and `serverSchema`; `./protocol.schema.json` is a draft-2020-12 JSON Schema covering both wire directions, envelopes and chunk payloads. Types, runtime server validation and schema generation share the authoritative protocol declarations.

## Building and packaging from the service repository

Run `npm run build` at the repository root, then `npm pack ./packages/client` (or `npm run pack:client`). The build generates standalone command declarations and copies only SDK ESM/declarations, schema, README and Apache-2.0 license. The service remains private; its former client subpath is replaced by this package. Install the produced tarball into an isolated consumer to test actual exports before publishing. No publication is performed by build or pack.
