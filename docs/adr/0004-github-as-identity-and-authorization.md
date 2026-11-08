# GitHub is the identity provider and the source of truth for repository access

Heartbeats reveal which lines of private code people are changing and why, so exactly the people who can read a repository may see its warnings. Users authenticate with GitHub (device flow for the CLI, OAuth for the dashboard), repositories are identified as `github.com/owner/name`, and every heartbeat, query, and subscription checks the user's read access to that repository through the GitHub API (cached about five minutes). The server's mirror clone and PR lookups use a GitHub App installed per organization with read-only contents permission.

**Amended in step 4:** one GitHub App per instance serves both the mirror and sign-in; there is no separate OAuth app. The CLI's bearer token is the user's own GitHub App user token. The server checks it with `GET /repos/{owner}/{name}`: 401 when GitHub does not accept the token, 403 when it cannot read the repository. Answers are cached for five minutes, refusals for 30 seconds. Refresh goes through the server, which holds the App's client secret.

## Considered Options

- A shared bearer token per team: anyone holding it sees every repository, and it does not solve mirror credentials.
- No auth behind a trusted network: only viable for a single user.

## Consequences

Highground supports GitHub only; GitLab or Bitbucket would each need an identity and permission adapter. Each self-hosted instance registers its own GitHub App. GitHub rotates refresh tokens on every use, so the CLI processes that share a sign-in refresh under a file lock.
