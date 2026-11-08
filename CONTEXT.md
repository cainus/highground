# Highground

A real-time awareness service that tells human developers and coding agents when someone else, on any branch, is changing the same lines they are about to change.

## Language

**Base commit**:
The merge-base of a client's branch with the repository's default branch; the shared reference that every client's line numbers are measured against.
_Avoid_: HEAD, parent commit

**Base coordinates**:
Line numbers expressed as positions in a file as it exists at the base commit, rather than in anyone's working copy.
_Avoid_: current lines

**Working-copy coordinates**:
Line numbers in a file as it currently exists on one client's disk; what a human or agent sees and thinks in.
_Avoid_: local lines, editor lines

### Who

**Machine**:
Any environment whose filesystem holds working copies — a laptop, a dev container, a cloud sandbox. A host and the containers on it are separate machines.
_Avoid_: host, box, computer

**Working copy**:
One checked-out directory of a repository (a clone or a worktree) on one machine; the unit of "self" — work in the same working copy never warns against itself.
_Avoid_: client, checkout, workspace

**Actor**:
A human, agent session, or CLI acting within a working copy.
_Avoid_: client, user, process

**Author**:
The person behind a working copy or a pushed branch, identified by their git email.
_Avoid_: owner, user

### Reporting

**Heartbeat**:
An actor's current statement of the ranges it is changing in a file; it supersedes that actor's previous heartbeat for the same file in the same working copy, whatever branch either was sent from.
_Avoid_: ping, update, edit event

**Direct overlap**:
Two ranges that share a line or touch with no unchanged line between them; git cannot merge them cleanly.
_Avoid_: collision (as a type), conflict

**Proximity alert**:
Two ranges separated by at least one and at most fifteen unchanged lines; they merge cleanly but may break each other.
_Avoid_: near miss, adjacency warning

**Speculative merge**:
Actually merging two pieces of unmerged work in the background, without a checkout, to learn whether they conflict.
_Avoid_: dry-run merge, test merge

**Confirmed warning**:
A warning whose conflict, or clean merge, has been established by a speculative merge rather than estimated from ranges.

**Approximate warning**:
A warning between two ranges whose base commits differ and could not be translated to a common base, so their lines may not line up exactly.
_Avoid_: fuzzy match, low-confidence collision

### Unmerged work

**Unmerged work**:
Any change that exists somewhere but is not yet on the default branch; this, not "unpushed" work, is what can conflict.
_Avoid_: unpushed work, in-flight edits

**Live work**:
Unmerged work on the branch currently checked out in a working copy, including its uncommitted changes.

**Parked work**:
Unmerged, unpushed commits on a local branch that is not checked out.

**Pushed work**:
Unmerged commits on a branch in the shared remote, whether or not its author runs a client.
_Avoid_: remote work, PR work
