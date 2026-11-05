/** A single choice question may list at most this many options. */
export const MAX_CHOICE_OPTIONS = 255;

/**
 * Splits items into consecutive shards of `shardSize`, keeping their order.
 * `shardSize` above MAX_CHOICE_OPTIONS is clamped to it, so no shard can overflow one choice question.
 */
export function shardOf<T>(items: readonly T[], shardSize: number): T[][] {
  if (!Number.isInteger(shardSize) || shardSize < 1) {
    throw new RangeError(`shardSize must be a positive integer, got ${shardSize}`);
  }
  const size = Math.min(shardSize, MAX_CHOICE_OPTIONS);
  const shards: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    shards.push(items.slice(start, start + size));
  }
  return shards;
}
