# A daemon merges the live worktrees it reports with each other, and merges grade nearby lines too

This amends ADR 0003 in two ways.

**Live against live, on one machine.** ADR 0003 left two pieces of live work to interval math, because their working trees are shared nowhere. That holds for two people's machines, but not for the worktrees of one repository on one machine. They share an object store, and one daemon reports them all. That daemon now merges each colliding pair of them with `git merge-tree`, as snapshot commits of both working trees, uncommitted and untracked work included. Each side's heartbeat carries the result as `local_merges`, and either side's report is enough for the server. A result holds only for the two working trees it merged. Once either side changes, the daemon drops it, has the partner stop sending it, and merges again. An agent's announced intent is in no working tree, so no merge confirms or clears it.

**Nearby lines are graded by the merge.** ADR 0003 kept proximity alerts interval-only, because a clean merge does not rule out a semantic break. The cost showed up in use. One person with dozens of worktrees saw every branch "near" every other in files most branches append to, such as an area map, each an approximate MEDIUM alert. A merge now grades nearby lines like any pair. A conflict confirms the pair as HIGH. A clean merge lowers it to LOW. It is still listed, so the possible semantic break stays visible, but below the pairs git cannot merge.

## Considered Options

- Hiding nearby-line alerts on files a repository lists as append-heavy. This is cheaper, but it is a guess about the file, and it hides real conflicts in it. Merging knows.
- Having heartbeats carry a snapshot commit for the server to merge. Every report would then make a snapshot, about a second of git work per worktree in a large repository, whether or not anything collides. The daemon merges only the pairs that collide.

## Consequences

The daemon runs one merge at a time, for colliding pairs only, and redoes a pair only when one side's reported changes have moved. Between one side changing and its partner's next report, the partner can vouch for a merge that no longer holds, for at most one report cycle. Untracked files' contents are not part of a working copy's signature, so editing an untracked file alone does not redo its merges.
