# LikeC4

- `model.c4`: conceptual system context model.
- `views.c4`: named views.
- `domain-map.c4`: candidate DDD context map.
- `runtime.c4`: the processes AIR runs as, what each may touch, and where they share state ([ADR-0011](../adr/0011-agent-execution.md), [ADR-0012](../adr/0012-read-only-console.md)).

This first view is a system context, **not** an approved bounded-context map or an implementation-level component design. Those will follow DDD discovery.

To validate locally install the LikeC4 CLI as a development dependency and run its validation command. Do not assume the model has passed CI until validation has actually run.
