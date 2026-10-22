/** Process-wide custody-key boundary, shared even by separate BrokerService instances.
 * Deployment must run ONE daemon process for a custody key (see README.md here).
 * Admission still uses SQLite's cross-connection BEGIN IMMEDIATE boundary.
 */
class Lane {
  private tail: Promise<void> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}
const lanes = new Map<string, Lane>();
const pumps = new Map<string, Lane>();
/** Drain serialization is separate from the short authorization/broadcast lane:
 * owner kill switches never wait behind a whole queue or FINAL-status polling. */
export function custodyPump(accountId: string, publicKey: string): Lane {
  const key = `testnet:${accountId}:${publicKey}`;
  let pump = pumps.get(key);
  if (!pump) { pump = new Lane(); pumps.set(key, pump); }
  return pump;
}
export function custodyLane(accountId: string, publicKey: string): Lane {
  const key = `testnet:${accountId}:${publicKey}`;
  let lane = lanes.get(key);
  if (!lane) { lane = new Lane(); lanes.set(key, lane); }
  return lane;
}
