# AIR Local Runtime

Run AIR on your own machine against a **test repository**. GitHub cannot reach `localhost`, so the local runtime **polls** repository comments instead of receiving webhooks. It feeds them to the same `IngestGitHubWebhook` use case a hosted webhook endpoint will use. Only the adapters differ.

```text
every AIR_POLL_INTERVAL_MS:
  GET /repos/<owner>/<repo>/issues/comments?since=<cursor>
    → GitHubCommentPoller (ID order, cursor saved after each comment)
    → IngestGitHubWebhook: /air issue comment? → write access? → claim
    → CommentCommandHandler → ExecuteDeliveryCommand (labels)
    → reply comment on the issue
```

## Setup

1. Create a private **test** repository. Do not point the local runtime at a production repository.
2. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) limited to that repository:
   - Issues: **Read and write**
   - Metadata: **Read**
3. Configure and start:

   ```bash
   cp .env.example .env   # set AIR_GITHUB_TOKEN and AIR_REPOSITORY
   npm ci
   npm run local:run
   ```

4. In an issue of the test repository, comment:

   ```text
   /air initialize
   Adopting this issue.
   ```

   Within one poll interval the issue gets `air:requirements:ready` and a reply.

The first start records "now" as the cursor: existing comments are never replayed as commands. The cursor lives in `.air/cursor.json`; delete it to start from "now" again.

## What works locally

| Command | Locally |
| --- | --- |
| `initialize` | ✅ |
| `unblock`, `rework` (with a reason) | ✅ |
| `advance`, `recover`, `close` | ❌ `precondition-failed`: evidence adapters do not exist yet (`UnavailableEvidence` fails closed) |

## Limitations

- **Replies are posted as the token owner**, not as a bot. They can never trigger a command, because a reply's first line is never `/air`.
- **Claims are in memory.** Run one process only. After a restart, protection against duplicates comes from the persisted cursor alone.
- **Latency** is up to one poll interval (default 20 s, minimum 5 s). A 20 s interval uses about 180 API requests per hour, plus a few per command.
- Comments are ingested in ID order. A comment that becomes visible in the API after a later comment was already processed is skipped. This is rare and is accepted for local use.
