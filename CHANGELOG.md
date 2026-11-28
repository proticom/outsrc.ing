# Changelog

## Unreleased

- Harden the macOS zombie-group check by using absolute `/bin/ps` and preserving attempts whose process group is absent from the listing.
- Clean up interrupted git-cow attempts on macOS when a process listing confirms that a group returning EPERM contains no live members. Preserve the attempt if the listing fails or reports a live member.
- Bound git-cow output draining after process exit, ignore invalid debug timeout overrides, and stop active git-cow groups with scoped cleanup when the sender shuts down. Cover escaped output holders, signal errors and sender exit semantics in regression tests. Document manual recovery after SIGKILL.
- Stop git-cow's whole process group on timeout on macOS and Linux, escalating to SIGKILL after two seconds before scoped cleanup and plain-git fallback. Keep launch reservations active during asynchronous worktree creation. Strengthen cleanup tests to preserve unrelated registrations that sort before the failed attempt.
- Add `worktree.command` with `git` (default) and `git-cow`. Failed git-cow attempts clean up their new job worktree and branch before falling back to plain git. Thread and inbox JSON and run logs record the method used. git-cow helper checkouts and their lock and warmed files are preserved.
