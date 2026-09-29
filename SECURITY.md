# Security policy

outsrc starts coding agents (Claude Code, Codex, Grok Build) on the owner's computer, as the owner. It is not a sandbox. The README's Security section describes what outsrc enforces and what it does not.

## Supported versions

Security fixes land in the latest published version. Upgrade with `npm install -g outsrc@latest`.

## Reporting a vulnerability

Report privately through [GitHub security advisories](https://github.com/proticom/outsrc.ing/security/advisories/new), or email oss@proticom.com. Do not open a public issue.

Include what you found, how to reproduce it, and the outsrc, Node and agent CLI versions. We aim to acknowledge reports within 3 business days.

Especially useful: ways for a caller to reach another caller's threads or repositories outside the allowlist, ways for a reviewed branch to run code, ways for a prompt to change CLI options, and ways around the job limits.

## Release integrity

Releases after 0.2.0 are published from GitHub Actions with npm trusted publishing (OIDC), with no stored npm token, and carry a provenance attestation. Check it with `npm audit signatures` after installing, or on the package's npm page. Version 0.2.0 was published by the maintainer before trusted publishing could be configured, because npm requires a package to exist first.
