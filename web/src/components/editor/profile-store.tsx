"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { api } from "@/lib/api/client";
import {
  ApiError,
  type Block,
  type CacheDimension,
  type Profile,
  type Rule,
} from "@/lib/api/types";
import { byRank, rankBetween } from "@/lib/rank";

/**
 * One store for the whole editor.
 *
 * The thing it exists to get right: every mutation carries the profile version
 * as If-Match and every response carries the new version and the new cache
 * mask. A block edit bumps the profile version server-side, and if the client
 * kept editing against the old one it would write against a mask that no
 * longer describes the page — which fails silently rather than loudly. So the
 * store treats version and cacheDimensions as things only the server may set,
 * and a 409 stops writes until the creator reloads rather than retrying.
 */

interface State {
  profile: Profile;
  /** Ids with a write in flight, for per-row disabled state. */
  pending: Set<string>;
  /** Set on 409. Every further write is blocked while this is true. */
  conflict: boolean;
  error: string | null;
}

type Action =
  | { type: "apply"; version: number; cacheDimensions: CacheDimension[] }
  | { type: "replace"; profile: Profile }
  | { type: "blocks"; blocks: Block[] }
  | { type: "upsertBlock"; block: Block }
  | { type: "removeBlock"; id: string }
  | { type: "upsertRule"; rule: Rule }
  | { type: "removeRule"; id: string }
  | { type: "pending"; id: string; on: boolean }
  | { type: "conflict" }
  | { type: "error"; message: string | null };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "apply":
      return {
        ...state,
        profile: {
          ...state.profile,
          version: action.version,
          cacheDimensions: action.cacheDimensions,
        },
      };
    case "replace":
      return { ...state, profile: action.profile, conflict: false, error: null };
    case "blocks":
      return { ...state, profile: { ...state.profile, blocks: action.blocks } };
    case "upsertBlock": {
      const exists = state.profile.blocks.some((b) => b.id === action.block.id);
      const blocks = exists
        ? state.profile.blocks.map((b) => (b.id === action.block.id ? action.block : b))
        : [...state.profile.blocks, action.block];
      return { ...state, profile: { ...state.profile, blocks: blocks.sort(byRank) } };
    }
    case "removeBlock":
      return {
        ...state,
        profile: {
          ...state.profile,
          blocks: state.profile.blocks.filter((b) => b.id !== action.id),
        },
      };
    case "upsertRule": {
      const exists = state.profile.rules.some((r) => r.id === action.rule.id);
      const rules = exists
        ? state.profile.rules.map((r) => (r.id === action.rule.id ? action.rule : r))
        : [...state.profile.rules, action.rule];
      return { ...state, profile: { ...state.profile, rules } };
    }
    case "removeRule":
      return {
        ...state,
        profile: {
          ...state.profile,
          rules: state.profile.rules.filter((r) => r.id !== action.id),
          blocks: state.profile.blocks.map((b) => ({
            ...b,
            ruleIds: b.ruleIds.filter((id) => id !== action.id),
          })),
        },
      };
    case "pending": {
      const pending = new Set(state.pending);
      if (action.on) pending.add(action.id);
      else pending.delete(action.id);
      return { ...state, pending };
    }
    case "conflict":
      return { ...state, conflict: true };
    case "error":
      return { ...state, error: action.message };
  }
}

export interface ProfileOps {
  updateProfileFields(
    patch: Partial<
      Pick<Profile, "displayName" | "bio" | "avatarUrl" | "mode" | "eventAt">
    > & { theme?: Partial<Profile["theme"]> },
  ): Promise<void>;
  claimHandle(handle: string): Promise<void>;
  reorder(blockId: string, toIndex: number): Promise<void>;
  createBlock(input: Pick<Block, "kind" | "label"> & Partial<Block>): Promise<void>;
  updateBlock(blockId: string, patch: Partial<Block>): Promise<void>;
  deleteBlock(blockId: string): Promise<void>;
  saveRule(rule: Omit<Rule, "id" | "warnings"> & { id?: string }): Promise<Rule | null>;
  deleteRule(ruleId: string): Promise<void>;
  publish(): Promise<void>;
  reload(): Promise<void>;
  dismissError(): void;
}

const Ctx = createContext<{ state: State; ops: ProfileOps } | null>(null);

export function ProfileProvider({
  initial,
  children,
}: {
  initial: Profile;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(reducer, {
    profile: { ...initial, blocks: [...initial.blocks].sort(byRank) },
    pending: new Set<string>(),
    conflict: false,
    error: null,
  });

  // Reads the latest state inside async callbacks without making every op
  // depend on the render that started it.
  const ref = useRef(state);
  ref.current = state;

  const guard = useCallback(
    async <T,>(id: string, run: (version: number) => Promise<T>): Promise<T | null> => {
      if (ref.current.conflict) return null;
      dispatch({ type: "pending", id, on: true });
      try {
        return await run(ref.current.profile.version);
      } catch (err) {
        if (err instanceof ApiError && err.isVersionConflict) {
          dispatch({ type: "conflict" });
        } else if (err instanceof ApiError && err.isUnauthorized) {
          window.location.href = "/login?error=expired";
        } else {
          dispatch({
            type: "error",
            message: err instanceof Error ? err.message : "That didn't save.",
          });
        }
        return null;
      } finally {
        dispatch({ type: "pending", id, on: false });
      }
    },
    [],
  );

  const ops = useMemo<ProfileOps>(() => {
    const pid = initial.id;

    return {
      async updateProfileFields(patch) {
        const previous = ref.current.profile;
        dispatch({
          type: "replace",
          profile: {
            ...previous,
            ...patch,
            theme: patch.theme ? { ...previous.theme, ...patch.theme } : previous.theme,
          },
        });
        const res = await guard("profile", (version) =>
          api.updateProfile(pid, patch, { version }),
        );
        if (!res) {
          dispatch({ type: "replace", profile: previous });
          return;
        }
        dispatch({ type: "replace", profile: res.data });
      },

      async claimHandle(handle) {
        const res = await guard("handle", (version) =>
          api.claimHandle(pid, handle, { version }),
        );
        if (!res) return;
        dispatch({ type: "replace", profile: res.data });
      },

      async reorder(blockId, toIndex) {
        const current = ref.current.profile.blocks;
        const from = current.findIndex((b) => b.id === blockId);
        if (from === -1 || from === toIndex) return;

        const moved = current[from]!;
        const without = current.filter((b) => b.id !== blockId);
        const after = toIndex > 0 ? without[toIndex - 1] ?? null : null;
        const before = without[toIndex] ?? null;

        // Optimistic rank so the list stays sorted while the write is in
        // flight. Thrown away the moment the server answers — it mints the
        // real key and may rebalance neighbours in the process.
        let optimistic = moved.rank;
        try {
          optimistic = rankBetween(after?.rank ?? null, before?.rank ?? null);
        } catch {
          /* Gap too small to split. The server will rebalance; order still
             shows correctly because we splice the array directly. */
        }
        const next = [...without];
        next.splice(toIndex, 0, { ...moved, rank: optimistic });
        dispatch({ type: "blocks", blocks: next });

        const result = await guard(blockId, (version) =>
          api.moveBlock(
            pid,
            blockId,
            { afterId: after?.id ?? null, beforeId: before?.id ?? null },
            { version },
          ),
        );

        if (!result) {
          dispatch({ type: "blocks", blocks: current });
          return;
        }
        dispatch({
          type: "blocks",
          blocks: next
            .map((b) => (b.id === blockId ? { ...b, rank: result.rank } : b))
            .sort(byRank),
        });
        dispatch({
          type: "apply",
          version: result.version,
          cacheDimensions: ref.current.profile.cacheDimensions,
        });
      },

      async createBlock(input) {
        const res = await guard("new", (version) => api.createBlock(pid, input, { version }));
        if (!res) return;
        dispatch({ type: "upsertBlock", block: res.data });
        dispatch({ type: "apply", version: res.version, cacheDimensions: res.cacheDimensions });
      },

      async updateBlock(blockId, patch) {
        const previous = ref.current.profile.blocks.find((b) => b.id === blockId);
        if (previous) dispatch({ type: "upsertBlock", block: { ...previous, ...patch } });

        const res = await guard(blockId, (version) =>
          api.updateBlock(pid, blockId, patch, { version }),
        );
        if (!res) {
          if (previous) dispatch({ type: "upsertBlock", block: previous });
          return;
        }
        dispatch({ type: "upsertBlock", block: res.data });
        dispatch({ type: "apply", version: res.version, cacheDimensions: res.cacheDimensions });
      },

      async deleteBlock(blockId) {
        const previous = ref.current.profile.blocks;
        dispatch({ type: "removeBlock", id: blockId });
        const res = await guard(blockId, (version) =>
          api.deleteBlock(pid, blockId, { version }),
        );
        if (!res) {
          dispatch({ type: "blocks", blocks: previous });
          return;
        }
        dispatch({ type: "apply", version: res.version, cacheDimensions: res.cacheDimensions });
      },

      async saveRule(rule) {
        const { id, ...input } = rule;
        const res = await guard(id ?? "new-rule", (version) =>
          id
            ? api.updateRule(pid, id, input, { version })
            : api.createRule(pid, input, { version }),
        );
        if (!res) return null;
        dispatch({ type: "upsertRule", rule: res.data });
        dispatch({ type: "apply", version: res.version, cacheDimensions: res.cacheDimensions });
        return res.data;
      },

      async deleteRule(ruleId) {
        const previous = ref.current.profile;
        dispatch({ type: "removeRule", id: ruleId });
        const res = await guard(ruleId, (version) => api.deleteRule(pid, ruleId, { version }));
        if (!res) {
          dispatch({ type: "replace", profile: previous });
          return;
        }
        dispatch({ type: "apply", version: res.version, cacheDimensions: res.cacheDimensions });
      },

      async publish() {
        const res = await guard("publish", (version) => api.publish(pid, { version }));
        if (!res) return;
        dispatch({ type: "replace", profile: res.data });
      },

      async reload() {
        try {
          const fresh = await api.profile(pid);
          dispatch({ type: "replace", profile: { ...fresh, blocks: [...fresh.blocks].sort(byRank) } });
        } catch (err) {
          if (err instanceof ApiError && err.isUnauthorized) {
            window.location.href = "/login?error=expired";
          }
        }
      },

      dismissError() {
        dispatch({ type: "error", message: null });
      },
    };
  }, [guard, initial.id]);

  return <Ctx.Provider value={{ state, ops }}>{children}</Ctx.Provider>;
}

export function useProfile() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useProfile must be used inside ProfileProvider");
  return ctx;
}

export function useBlockRules(block: Block): Rule[] {
  const { state } = useProfile();
  return useMemo(
    () =>
      block.ruleIds
        .map((id) => state.profile.rules.find((r) => r.id === id))
        .filter((r): r is Rule => Boolean(r))
        .sort((a, b) => a.priority - b.priority),
    [block.ruleIds, state.profile.rules],
  );
}
