# outsrc

Good work takes a team. outsrc lets a Grok Bot hand coding tasks to Claude Code, Codex or Grok Build on your computer. Each task runs in its own git worktree, and the result comes back to an inbox.

Site: https://outsrc.ing

## Install

Add the Outsrc bot from Bot Exchange. The listing is not live yet. Once installed, the bot walks you through setup on your computer.

This repository is the open-source harness the bot runs. You only need it to build your own bot, contribute, or run outsrc by hand.

## Security

outsrc is not a sandbox. Agents run as you, on your computer, in the repositories you allow. Review their work before you ship it. Details: https://outsrc.ing/security.md

To report a vulnerability, see [SECURITY.md](SECURITY.md).

### What outsrc adds over calling the CLIs directly

- **Only the repositories you chose**, each job in its own git worktree and branch. Your checkout stays untouched.
- **No inherited secrets.** Jobs get only `PATH`, `HOME`, `USER`, `LANG`, `TMPDIR` and `TERM` from your environment.
- **Read-only reviews.** Reviews never get the flags that skip approvals, and plugin reviews never get `--write`.
- **Reviewing a branch does not run the branch.** Hooks and MCP servers in a branch's `.claude/`, `.codex/`, `.grok/`, `.cursor/` or `.mcp.json` run commands as soon as a CLI opens the folder. For reviews, outsrc keeps those files out of the worktree (git still shows them in the diff), Claude loads only your own settings and no MCP servers, and repository `setup` commands do not run. Tested with a branch that tried each route: called directly, Claude ran its hooks and MCP server, and Codex ran its MCP server when the repository was trusted. Through outsrc, none ran.
- **Prompts stay text.** outsrc passes `--` before the prompt, so a message starting with `--` cannot set an option.
- **No chains.** Jobs run with `OUTSRC_JOB=1`, and an outsrc server started inside a job refuses `send`.
- **Separate callers.** Each caller sees only its own threads.
- **Private state.** `~/.outsrc` is created readable by you only.
- **Bounded jobs.** By default at most 4 jobs at once and 2 hours per run; the owner can change both (see Settings). `stop` signals a process only if it is still the job outsrc started.
- **Pinned vendor engines**, checked daily for upstream changes.

## Running the harness yourself

It needs Node 22.12 or later (22.x, 24.x or 26+), git, and at least one of the `claude`, `codex` or `grok` CLIs, logged in.

```bash
npm install -g outsrc
outsrc init
```

Install it globally rather than running it through `npx`: agents launch the installed copy, and the npx cache moves. Upgrade with `npm install -g outsrc@latest`.

`outsrc init` is safe to rerun and keeps existing settings. It:

1. Checks Node and git, finds the installed CLIs and checks each is logged in.
2. Downloads the pinned Codex and Grok plugin engines into `~/.outsrc/engines/`. Claude Code is not needed for this. `--no-plugins` calls the CLIs directly instead.
3. Asks which repositories agents may work in. Repositories are added only by running `outsrc` on this computer; MCP callers cannot add them.
4. Asks for the limits: how many jobs may work at once, and how long a run may take (see Settings).
5. Writes `~/.outsrc/config.toml` and reports on each target.
6. Offers to register outsrc as an MCP server with each installed CLI.

For agents and scripts, `outsrc init --json --repo <path> [--repo <path>] [--local claude,codex,grok] [--max-jobs <n|unlimited>] [--max-run-minutes <n|unlimited>]` prints one JSON event per line and exits with code 3 when a person has to act, such as logging in to a CLI. Rerun it after that step. Without `--local`, nothing is registered. A `settings` event lists the limits, repositories and targets so the agent can review them with the owner.

`outsrc doctor` rechecks the configuration. `OUTSRC_HOME` moves the state directory away from `~/.outsrc`, which outsrc keeps readable by you only.

## Settings

`outsrc config` lists every setting with its current value, its default and what it means. `outsrc config set <key> <value>` changes one, and `outsrc config unset <key>` restores the default or removes an entry. Each change is checked against the whole configuration before the file is written, the previous file is kept as `config.toml.bak`, and running MCP servers pick it up on their next call. MCP callers can read settings with the `settings` tool but cannot change them: only someone who can run `outsrc` on this computer can.

| Key | Values | Default |
| --- | --- | --- |
| `limits.max_jobs` | a positive whole number, or `unlimited` | 4 |
| `limits.max_run_minutes` | a positive whole number, or `unlimited` | 120 |
| `repos.<alias>` | `{"path": "/absolute/path"}` to add; `unset` to remove | |
| `repos.<alias>.setup`, `.auto_commit`, `.retention_days` | see Repository options | none, `false`, none |
| `targets.<name>` | a JSON object, such as `{"adapter": "claude", "command": "claude"}` | |
| `targets.<name>.permissions` | `auto` or `ask` | `auto` |
| `targets.<name>.effort.default`, `.effort.allowed` | a value, and a comma list | |
| `targets.<name>.models.default`, `.models.allowed` | a value, and a comma list | the CLI's choice |
| `targets.<name>.description`, `.cost_note`, `.command`, `.args`, `.adapter` | see Targets | |

Values are read as JSON when they parse (`true`, `14`, `[["npm","ci"]]`) and as text otherwise. Aliases may contain dots: `outsrc config set repos.outsrc.ing.auto_commit true` works.

Unlimited is allowed, and `outsrc config` prints what it risks. With no job cap, a looping or confused bot can start many agents at once, slowing the computer and running up usage and rate limits. With no time limit, a stuck agent (waiting for input, a test runner in watch mode, a loop) runs until someone stops it.

## Callers

Each client connects as a named caller: `outsrc-mcp --caller grok`, or `--caller <id>` on CLI commands. A caller sees and controls only its own threads. Another caller's thread answers exactly like one that does not exist.

Every job runs with `OUTSRC_JOB=1` in its environment. An outsrc server started inside a job refuses `send`, so a delegated agent cannot hand work on to another agent. Only the caller that started a job can send more work.

## How a conversation works

1. Call `list_repos` and `list_targets`.
2. Call `send` with `repo`, `target` and `message`. Optional: `model`, `effort`, `kind` (`task`, `review` or `adversarial_review`), `ref` (the branch, tag or commit to start from) and `base` (what a review compares against).
3. Poll `inbox` at its `retry_after_seconds`. The delay grows from 30 seconds to 5 minutes as a run ages, and working runs include recent log lines.
4. If the status is `needs_input`, the agent stopped with a question. Answer with `send({thread_id, message})`. outsrc resumes the same vendor session in the same worktree. Finished threads accept follow-ups the same way.

Pass a stable `request_id` when retrying a `send`. The same request returns the original thread and run; the same ID with different content is an error.

## Tools

The MCP tools and the CLI commands return the same JSON.

| Tool | What it does |
| --- | --- |
| `list_repos` | Repositories agents may work in |
| `list_targets` | Available agents, their models and effort levels, and the owner's cost notes |
| `send` | Start a task, or continue a finished or waiting thread |
| `inbox` | A thread's status, question, or final answer with findings |
| `threads` | This caller's threads and their status |
| `settings` | Every setting with its value, default and meaning (read-only) |
| `history` | Every run in a thread, with its message and result |
| `usage` | Local usage for today and the last 7 days, including totals by target |
| `log` | A slice of a run's log |
| `diff` | Changes since the thread started, committed or not (256 KiB by default) |
| `stop` | Cancel a running thread |
| `discard` | Delete a finished thread's worktree and branch, keeping its results |

CLI only: `outsrc config set` and `unset` change settings, `outsrc prune` deletes finished worktrees past their retention period, `outsrc migrate` imports threads from earlier versions, and `outsrc plugins` checks the plugin engines.

### Local usage and spend

Run `outsrc usage --caller grok --json` or call the MCP `usage` tool. Omit `--caller` on the CLI to include all callers. The command reads saved runs on this computer. It does not contact providers, scrape dashboards, or send usage to a cloud service.

Every successful `inbox` response and every run in `history` includes these fields, including working, waiting, failed, and cancelled runs:

```json
{
  "target": "grok-plugin",
  "effort": null,
  "model": "grok-4.7-build",
  "usage": {
    "tokens_in": 30655,
    "tokens_out": 369,
    "estimated_cost_usd": 0.021794,
    "wall_minutes": 2
  }
}
```

The numbers above illustrate the shape. `tokens_in` and `tokens_out` are the vendor's reported input/output counters. Separate cache and reasoning counters are not added. `estimated_cost_usd` is the vendor-reported USD cost estimate; outsrc does not apply a price table or infer a subscription charge. `model` is the vendor-reported model, or the sole model named in its `modelUsage` metadata. It is null when unreported or ambiguous, even if a model was requested. `effort` is the explicit setting passed in that run's invocation, not a guessed vendor default. Paths that ignore effort, including Codex plugin branch reviews, report null.

Claude and Grok native envelopes expose counters and cost when provided. Codex native completed-turn events expose counters; cost and model remain null. Grok plugin review envelopes can expose usage. Custom adapters and Codex plugins currently have no supported usage metadata, so their tokens, cost, and model fields are null. Model-generated answer text is never interpreted as usage metadata.

`wall_minutes` measures elapsed wrapper time, including setup, agent execution, plugin teardown, and result collection. It excludes time before the wrapper starts. Working runs, old records, and interrupted runs without a recorded duration have null wall minutes. Old records require no migration. Missing or invalid vendor metadata produces explicit nulls, never zero or invented numbers. A reported zero remains zero. Recorded metadata is retained if a later commit or result collection fails.

The usage report has `as_of`, `today`, and `last_7_days`. Today starts at midnight in the local process time zone; the 7-day window is the preceding 168 hours. Runs are assigned by their submission time (`created_at`), including continuations, working runs, and retained discarded threads. Each window includes `since`, `runs`, the four numeric metrics, and a sorted `by_target` array with the same counts and metrics. Each metric is `{ "total": number | null, "missing_runs": number }`. A total is null if any included run lacks that metric, so known partial spend cannot appear as a complete total. Empty windows have zero runs and zero totals. Each saved run is counted once.

## Repository options

```toml
[[repos]]
alias = "example"
path = "/absolute/path/example"
setup = [["npm", "ci"]]   # runs once in a new task worktree, before the first run
auto_commit = true        # commit a successful task's changes
retention_days = 30       # let prune remove finished worktrees after 30 days
```

All three options are optional. A failed setup fails the run. outsrc does not copy `.env` files or other untracked files into worktrees. Running and waiting threads are never pruned, and saved results outlive their worktrees.

## Targets

A target is one agent outsrc can start. `list_targets` shows what is configured, and `config.example.toml` has a starting point.

| Adapter | Runs |
| --- | --- |
| `claude` | The Claude Code CLI |
| `codex`, `grok` | The Codex or Grok Build CLI directly |
| `codex-plugin`, `grok-plugin` | The vendors' plugin engines (below) |
| `custom` | Any command that prints outsrc's JSON result |

`permissions = "auto"` lets a task edit files and run commands without approval: Claude `--permission-mode bypassPermissions`, Codex `--approve-for-me`, Grok `--always-approve`, or `--write` for a plugin. `permissions = "ask"` leaves those flags off. Reviews always run as `ask`, whatever the target says, and without the branch's agent settings (see Security).

A custom target prints one JSON object with `kind` (`completed`, `needs_input` or `failed`), `message`, `sessionId` and `findings`. Its `args` may use `{session_id}` (required to resume), `{worktree}`, `{model}`, `{effort}` and `{schema}`. outsrc appends the prompt as the last argument.

Each finding has `priority` (`P0` to `P3`), `title`, `body`, `path` (or null) and `line` (or null).

## Vendor plugin engines

The `codex-plugin` and `grok-plugin` adapters drive the vendors' own Claude Code plugins, [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) and [xai-org/grok-build-plugin-cc](https://github.com/xai-org/grok-build-plugin-cc), both Apache-2.0. The plugin launches the CLI and supplies the review prompts, output schema and, for Codex, the built-in reviewer. outsrc keeps the mailbox, worktrees, repository list and filtered environment. It runs the engine scripts directly; no Claude Code session is involved.

`engines.lock.json` pins each plugin to one git commit that passed the live smoke test, the way a lock file pins dependencies. `init` fetches exactly that commit. An upstream change reaches you only when an outsrc release moves the pin. If the pinned engine is missing, outsrc falls back to a Claude Code install of the same plugin, which is not pinned. A target's `command` can point at any copy of `codex-companion.mjs` or `grok-bridge.mjs`.

| Request | Plugin command |
| --- | --- |
| `task` | Codex `task`, Grok `run`, with `--write` when permissions are `auto` |
| follow-up | the same command with `--resume-last` |
| `review` with `base` | the plugin's diff review against `base` |
| `adversarial_review` with `base` | Codex `adversarial-review` or Grok `critique`, with the message as the focus |
| review without `base` | a read-only task with review instructions |
| `stop` | the plugin's `cancel` or `stop`, then the job's process group |

Each thread has its own plugin data directory, and after every Codex run outsrc stops the app-server that the plugin leaves running.

Grok and Docker Desktop on macOS: Grok's read-only sandbox refuses to start when `/var/run/docker.sock` is a symlink, which Docker Desktop creates by default. In Docker Desktop, turn off Settings → Advanced → "Allow the default Docker socket to be used", then run `sudo rm /var/run/docker.sock` in a terminal. The `docker` CLI keeps working. This affects Grok reviews, not Grok write tasks.

### When a plugin changes

The plugin scripts are the vendors' internal CLIs, not a documented API. outsrc checks them three ways:

- `outsrc plugins` checks the installed engines without running a model: the subcommands and flags outsrc uses, the environment names, the Codex shutdown hook, and a JSON status call. Each engine is `ok`, `unverified` (compatible, but not the pinned version) or `broken`.
- `doctor` and `list_targets` include the same result, so a caller sees a warning too.
- `.github/workflows/plugin-drift.yml` runs the check daily against both upstream repositories and opens an issue when either drifts.

To move a pin, run `outsrc engines pin <codex-plugin|grok-plugin> <commit|branch|tag>`. It updates `engines.lock.json` only if the contract check passes. Then run `npm run smoke:plugins` and keep the change only if that passes too.

## Limits

outsrc checks that thread and run paths stay inside its state directory, and it signals a process only if it is still the job outsrc started. By default at most 4 threads work at once and a run is stopped after 2 hours (both settings). A run log stops growing at 1 MiB, and `log` returns at most 8 KiB.

None of this confines a task. A worktree is not a sandbox, and the filtered environment is not a credential boundary. The prompt asks agents not to push or open pull requests, but nothing enforces that.

A task trusts the code it starts from: a task on someone else's branch (`ref`) runs that branch's code and settings with the task's permissions, so review such a branch first. A reviewed branch's `CLAUDE.md` or `AGENTS.md` still reaches the reviewer and can try to steer its answer, though the reviewer cannot edit or run anything. Grok skips a project's settings only while the folder is untrusted, so do not mark your home folder or `~/.outsrc` as trusted in Grok.

## Development

From a checkout: `npm install`, `npm run build`, then `npm link` to put the checkout's `outsrc` on your PATH.

`npm run verify` builds, type-checks, runs the tests, then repeats the MCP workflow against the built server. `npm test` runs the tests alone. Tests use real git worktrees and child processes with a fixture agent.

Two live checks use your own provider accounts and can cost money: `npm run smoke:native` runs a question and a follow-up through each CLI target, and `npm run smoke:plugins` does the same plus an adversarial review through each plugin engine.

## License

MIT. See `LICENSE`.
