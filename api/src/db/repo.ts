import type { Block, DailyStat, Profile, User, RefreshRecord } from '../domain/types.ts';
import type { TClickEvent } from '../domain/schema.ts';

export type CreateProfileInput = Omit<Profile, 'id' | 'version' | 'createdAt' | 'updatedAt' | 'publishedVersion'>;

export type HandleState =
  | { status: 'free' }
  | { status: 'taken'; profileId: string }
  /** Released by a rename; only the profile that gave it up may reclaim it. */
  | { status: 'tombstoned'; profileId: string; until: number };

/**
 * Every persistence operation the API performs. Two implementations exist:
 * `DynamoRepo` for production and `MemoryRepo` for development and tests.
 *
 * These two are required to behave identically, and `test/conformance.test.ts`
 * runs the same suite against both to keep them that way. They previously
 * differed on handle tombstones, analytics totals, event recording and the
 * shape of what they returned, which meant a green suite certified behaviour
 * production did not have.
 */
export interface Repo {
  // ---- users ----
  createUser(email: string, passwordHash: string): Promise<User>;
  getUser(userId: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;

  /** Stores a hashed refresh token. Rotation is why these are single-use. */
  putRefreshToken(rec: RefreshRecord): Promise<void>;
  /** Atomically consumes a refresh token, returning it only if it was unused and unexpired. */
  consumeRefreshToken(userId: string, tokenHash: string): Promise<RefreshRecord | null>;
  revokeRefreshTokens(userId: string): Promise<void>;

  // ---- profiles ----
  /** Atomically claims the handle and writes the profile, or throws ConflictError. */
  createProfile(input: CreateProfileInput): Promise<Profile>;
  getProfile(id: string): Promise<Profile | null>;
  getProfileByHandle(handle: string): Promise<Profile | null>;
  listProfiles(userId: string): Promise<Profile[]>;
  /**
   * `expectedVersion` is the If-Match value. When supplied and the stored
   * version differs, this throws VersionConflictError and writes nothing.
   */
  updateProfile(id: string, patch: Partial<Profile>, expectedVersion?: number): Promise<Profile>;
  /** Transactionally releases the old handle and claims the new one. */
  claimHandle(profileId: string, oldHandle: string, newHandle: string, expectedVersion?: number): Promise<Profile>;
  /** Free / taken / tombstoned, for the signup form and the rename guard. */
  handleState(handle: string): Promise<HandleState>;
  deleteProfile(id: string): Promise<void>;

  // ---- blocks ----
  listBlocks(profileId: string): Promise<Block[]>;
  getBlock(profileId: string, blockId: string): Promise<Block | null>;
  putBlock(block: Block): Promise<Block>;
  updateBlock(profileId: string, blockId: string, patch: Partial<Block>): Promise<Block>;
  /** Rank lives in the sort key, so a move is a delete plus a put in one transaction. */
  moveBlock(profileId: string, blockId: string, newRank: string): Promise<Block>;
  deleteBlock(profileId: string, blockId: string): Promise<void>;
  /** Rewrites every rank in the list. The escape hatch when a seam runs out of keys. */
  rebalanceBlocks(profileId: string): Promise<Block[]>;

  // ---- analytics ----
  recordEvents(events: TClickEvent[], profileId: string): Promise<void>;
  getDaily(profileId: string, from: string, to: string): Promise<DailyStat[]>;
  getBlockTotals(profileId: string): Promise<Record<string, number>>;

  /** Feed blocks due for a refresh, from one shard of the sparse GSI2 index. */
  dueForRefresh(shard: number, now: number, limit: number): Promise<Block[]>;
}

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
/** The If-Match version did not match the stored one. Distinct from ConflictError so routes can say which. */
export class VersionConflictError extends Error {
  current: number;
  constructor(current: number) {
    super(`version is ${current}`);
    this.current = current;
  }
}
