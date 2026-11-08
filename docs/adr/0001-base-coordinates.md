# Ranges are reported in base coordinates, not working-copy lines

Two clients on different branches number the same line differently, so comparing raw working-copy line numbers produces false overlaps and misses real ones — worst exactly across branches, the case the service exists for. Every range is therefore expressed in base coordinates: positions in the file at the merge-base of the client's branch with the default branch, computed client-side with `git diff -U0 <merge-base>` (which also captures committed-but-unpushed work). Heartbeats carry the base commit SHA; the server translates between differing bases through its mirror clone, and marks a warning approximate only when a base is not yet in the mirror.

## Considered Options

- Raw working-copy lines against `HEAD` (the original spec): correct only for clients on the same commit, and blind to unpushed commits.
- Base coordinates against `HEAD`: fixes same-commit numbering but still breaks across branches and misses unpushed work.

## Consequences

Clients (the daemon and the MCP server) must translate working-copy lines to base coordinates on the way in, and peer ranges back to working-copy lines on the way out, so agents and humans never see base coordinates.
