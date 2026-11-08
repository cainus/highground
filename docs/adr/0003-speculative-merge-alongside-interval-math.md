# Speculative merges confirm or refute warnings wherever both sides' commits are available

Interval math estimates a conflict; `git merge-tree --write-tree` performs the merge and knows. Interval math runs on every heartbeat as the instant first pass and is the only check between two pieces of live work, whose working trees are not shared anywhere. Wherever both sides exist as commits — pushed against pushed on the server's mirror, live or parked against pushed in the daemon via a snapshot commit of the working tree (built through a copy of the index, untracked files included, touching neither the real index nor the stash) — a speculative merge upgrades the warning to confirmed or downgrades it when the merge is clean. Proximity alerts stay interval-only, because a clean merge does not rule out a semantic break.

This departs from the original spec's "deterministic interval math only" stance. It is still deterministic — it is git's own merge — and it is what Crystal (Brun et al., 2011) and GitLens's branch-conflict check already do.

## Consequences

The daemon runs one `merge-tree` per unmerged pushed branch that touches the same files, debounced; the server, not the daemons, fetches from the remote and tells each daemon over SSE which refs it needs.
