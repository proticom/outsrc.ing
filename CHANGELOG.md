# Changelog

## Unreleased

- Stop git-cow's whole process group on timeout on macOS and Linux, escalating to SIGKILL after two seconds before scoped cleanup and plain-git fallback. Keep launch reservations active during asynchronous worktree creation. Strengthen cleanup tests to preserve unrelated registrations that sort before the failed attempt.
- Add `worktree.command` with `git` (default) and `git-cow`. Failed git-cow attempts clean up their new job worktree and branch before falling back to plain git. Thread and inbox JSON and run logs record the method used. git-cow helper checkouts and their lock and warmed files are preserved.
