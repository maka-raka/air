# AI Relay — Open Architecture Questions

These are unresolved; do not treat proposals as approved decisions.

1. Which conceptual areas are true DDD bounded contexts versus application capabilities?
2. How are transitions made safe under concurrent GitHub label updates?
3. How is review integrated in the MVP across repositories with differing existing setups?
4. Should deployment-triggered transitions override blocked/waiting states? What evidence is required?
5. What minimum data access is needed for accept and observe, and which capabilities are safe in production?
6. How is evidence bound to a commit or deployment to avoid stale gate results?
7. Which runtime artifacts are copied into client repositories, and how is drift detected?
8. What limits should be enforced at the application layer before moving to autonomous CI?
