# A working copy's identity is a random UUID stored in `.highground/id` inside it

"Self" is the working copy: work in the same working copy can never merge-conflict with itself, so warnings are suppressed only there. An identity derived from machine ID and path collides across dev containers built from one image (shared `/etc/machine-id`, same `/workspace` path), which would silently suppress every warning between them. The identity is instead a UUID generated on first use and written to `.highground/id` in the working tree, excluded through `.git/info/exclude`. It travels with the working copy, two bind mounts of one worktree correctly share it, and it is readable even inside a container where git cannot run because the worktree's `.git` file points at a host path.

## Considered Options

- Hash of machine ID and path: collides across containers.
- `git config --worktree`: unreadable where git does not work, such as a container on a bind-mounted host worktree.

## Consequences

The daemon writes its discovery file, `.highground/daemon.json`, beside the identity, which lets an MCP server in a container find a daemon running on the host.

Parked work is the exception: it belongs to the repository, not to one working copy, because every worktree of a repository shares its branches. Keyed by each worktree's id, one parked branch was reported once per worktree, and each copy warned against the others, all of them the user's own. Parked work therefore reports under the repository's id, a random UUID in `highground-id` in the git directory the worktrees share. Git ignores unknown files there, and a container mounting the same repository reads the same id. A daemon watching several worktrees of one repository has the first readable one send its parked work.
