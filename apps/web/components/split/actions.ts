"use client";

import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useSplitInvalidate } from "./shared";

/**
 * The writes both split pages make — the overview and a group's page — so
 * they refresh the same queries and report errors the same way.
 */
export function useSplitActions(onError: (err: unknown) => void) {
  const invalidate = useSplitInvalidate();
  const post = (path: string) => (body: Record<string, unknown>) =>
    api(path, { method: "POST", body: JSON.stringify(body) });
  const del = (path: string) => (id: string) =>
    api(`${path}/${id}`, { method: "DELETE" });
  const move =
    (path: string) =>
    ({ id, groupId }: { id: string; groupId: string | null }) =>
      api(`${path}/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ groupId }),
      });
  const opts = { onSuccess: invalidate, onError };

  return {
    addFriend: useMutation({
      mutationFn: (name: string) =>
        api<{ id: string; name: string }>("/split/friends", {
          method: "POST",
          body: JSON.stringify({ name }),
        }),
      ...opts,
    }),
    removeFriend: useMutation({ mutationFn: del("/split/friends"), ...opts }),
    addExpense: useMutation({ mutationFn: post("/split/expenses"), ...opts }),
    removeExpense: useMutation({ mutationFn: del("/split/expenses"), ...opts }),
    moveExpense: useMutation({ mutationFn: move("/split/expenses"), ...opts }),
    addSettlement: useMutation({
      mutationFn: post("/split/settlements"),
      ...opts,
    }),
    removeSettlement: useMutation({
      mutationFn: del("/split/settlements"),
      ...opts,
    }),
    moveSettlement: useMutation({
      mutationFn: move("/split/settlements"),
      ...opts,
    }),
  };
}
