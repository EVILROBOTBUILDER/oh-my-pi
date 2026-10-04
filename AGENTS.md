# Repository Guidelines

## Project Overview

`omp` — a coding agent with the IDE wired in. Fork of [Pi](https://github.com/badlogic/pi-mono) by Stencil Labs (`v18.3.5`, MIT). Polyglot monorepo: TypeScript agent app (Bun) + Rust native core (N-API addon) + Python sidecars. Ships as a single `dist/omp` binary (~245 MB): `60+` providers, `31` built-in tools, LSP/DAP clients, TUI + print + RPC modes, subagent fan-out, memory backends.

## Architecture & Data Flow

Three layers. TS owns the agent loop and UX; Rust compiles to **one N-API `.node` addon** (no Rust `main`); Python runs adjacent services.

```text
terminal / tool call
  └─ packages/coding-agent (Bun): cli.ts → commands/* → main.ts → AgentSession
       ├─ Rust via packages/natives → pi-natives (.node): shell/edit/ast/grep/glob/vcs/…
       ├─ Python sidecars: python/omp-rpc, python/robomp (serve)
       └─ output: TUI render / print text-json / RPC JSONL
```

Rust data-flow patterns (all behind `#[napi]` in `crates/pi-natives/src/`):

- `shell.rs → pi-shell → brush-core`: parse → expand → execute; streams via flume channel, ≤64 KiB chunk pump, 30 s stall timeout → `ShellRunResult`.
- `js.rs`: zero-copy JS-string borrows via 64 KiB per-thread scratch arena; `into_string()` only when text outlives the callback.
- `task.rs`: CPU work on libuv pool via napi `Task` + cooperative `CancelToken`.
- `pi-edit`: `arg deltas → ArgStream → ArgSnapshot → ModeEngine::preview (TUI) / stage → StagedFile[] → EditWriter` (atomic apply). Modes: `Replace`, `Patch`, `ApplyPatch`, `Hashline`, `Sloppy`.
- `pi-vfs`: injectable async `Fs` / sync `BlockingFs`; providers see paths verbatim incl. `scheme://…` URLs.
- `pi-vcs`: `Repo` enum dispatches `GitRepo` (gitoxide) vs `JjWorkspace` (jj-lib).
- `pi-predict`: `ngram` (auto) / `smollm` (opt-in) / `apple` (macOS) behind `Predictor` trait.
- `pi-iso`: one `IsolationBackend` trait over APFS-clonefile / overlayfs / ProjFS / `Rcopy` fallback.
- `pi-voice` stays napi-free; thin `#[napi]` adapters live in `pi-natives` (`audio.rs`, `live.rs`).

## Key Directories

| Path | Purpose |
|---|---|
| `packages/coding-agent/src/` | CLI + agent loop. `cli.ts`, `main.ts`, `sdk.ts`; `session/`, `tools/`, `modes/`, `mcp/`, `task/`, `lsp/`, `exec/` |
| `packages/ai/src/` | Provider implementations, auth, proxy, schema normalize |
| `packages/tui/src/` | Terminal renderer, kitty graphics, markdown, vim mode |
| `packages/natives/` | JS loader for the `.node` addon (`gen:native`) |
| `packages/utils/`, `packages/wire/` | Shared TS helpers; wire-protocol types |
| `packages/catalog/` | Model/provider catalog (`gen:models`, `gen:compat`) |
| `packages/mnemopi/` | Memory/embedding engine; `packages/agent/`, `packages/omptype/`, `packages/snapcompact/`, `packages/collab-web/` adjacent |
| `crates/pi-natives/src/` | Sole cdylib: 40+ `#[napi]` modules (`shell`, `grep`, `ast`, `edit`, `vcs`, `pty`, `task`, `crash_handler`, …) |
| `crates/pi-shell`, `pi-builtins`, `pi-vfs`, `pi-walker` | Embedded brush shell + ~60 in-process coreutils + injectable FS + traversal |
| `crates/pi-ast`, `pi-edit`, `pi-diff`, `pi-vcs`, `pi-iso`, `pi-predict`, `pi-voice` | Tree-sitter parsing; edit engine; Myers diff (UTF-16 JS / UTF-8 Rust); git+jujutsu; isolation; completion; audio |
| `crates/vendor/` | Patched forks: `brush-core`, `napi`, `cfg_aliases`, `tree-sitter-go` (see root `Cargo.toml` comments for why) |
| `docs/` | Authoritative reference (82 files): `tools/` per-tool, `toolconv/` per-model-family, arch/config/session/TUI/memory guides |
| `scripts/` | `ci-test-ts.ts` (test orchestrator), `run-rs-task.ts`, release/bazel/changelog generators |
| `python/robomp/`, `python/omp-rpc/` | Worker queue service + RPC client |
| `infra/` | Kata runner, bazel-remote, runner image docs |

## Development Commands

Run from repo root unless noted. Never bare `bun install`; never invoke `tsc` directly.

```bash
bun install --frozen-lockfile                      # REQUIRED first
bun --cwd=packages/coding-agent src/cli.ts         # dev loop (bun run dev)
bun --cwd=packages/coding-agent run build          # → packages/coding-agent/dist/omp
bun run build                                      # all workspaces (heavy, incl. natives)
bun run build:native                               # cargo/napi-rs addon only

bun run check        # the gate: oxlint + oxfmt --check + tsgo types + cargo
bun run lint         # oxlint (.) + cargo clippy
bun run fmt          # oxfmt + cargo fmt
bun run fix          # autofix both sides

bun run test         # TS local suite (scripts/ci-test-ts.ts local)
bun run test:ts      # TS only; ci:test:ts = full CI; buckets: :workspace :native
bun run ci:test:coding-agent:singleton | :ui | :runtime | :native | :heavy
bun run ci:test:smoke   # --version && --help && stats --help && --smoke-test
bun run test:rs      # cargo nextest --workspace + doctests (needs pinned nightly)
bun run test:py      # pytest -x python/omp-rpc/tests + python/robomp/tests
bun run lint:py / fix:py                            # ruff check / format
```

Safety: `dist/omp` is the live harness (`~/.local/bin/omp` symlinks it) — back it up before building. Never commit/push. Leave `packages/coding-agent/src/tools/browser/relay/extension-assets/manifest.json.txt` (pre-existing local modification) alone. After changing React tool renderers under `collab-web/src/tool-render/`, run `bun run gen:tool-views`.

## Code Conventions & Common Patterns

- **Rust**: edition/style_edition 2024, hard tabs, `max_width = 100` (`rustfmt.toml`; ignores `vendor/brush-core/**`, `pi-builtins/**`). Clippy `correctness` + `suspicious` = deny, rest warn; every `#[allow]` needs `reason =`. Errors via `thiserror` types + `anyhow` at boundaries; `panic = "unwind"` so uutils panics become failed commands and `task::blocking` unwinds become rejected Promises. Concurrency: tokio full, rayon parallel iterators, dashmap/parking_lot, flume channels. Naming: `snake_case` fns/modules, `CamelCase` types/traits, `SCREAMING` consts; per-builtin cargo features (`builtin.cd`, `util.grep`).
- **TypeScript**: oxfmt tabs width 3, `printWidth: 120`, double quotes, semicolons, trailing commas all, `arrowParens: avoid` (`.oxfmtrc.json`); oxlint `prefer-const: error`, `_`-prefixed unused ok. ESM (`"type": "module"`), `.test.ts` co-located with source, `import … from 'bun:test'`; mock providers via `createMockModel()`, HTTP via fixture localhost servers / `httpx.MockTransport`; assert observable behavior, not internals. Entry: `cli.ts` (also hidden `__omp_worker_*` host) → `main.ts runRootCommand` → `sdk.ts AgentSession`.
- **Python**: `snake_case.py`, `ruff check + format`; `pytest-asyncio` auto mode; `ROBOMP_INTEGRATION=1` gates subprocess integration tests; `conftest.py` fixtures, `tmp_path` isolation.
- **Scripts**: `kebab-case.ts` run as `bun scripts/<name>.ts`; shell `kebab-case.sh` (executable); prompt assets as `.md` under `prompts/`; internal `://` schemes (`agent://`, `docs://`, `pr://`, `skill://`, `xd://`) resolve inside FS-shaped tools.
- **State/DI**: `Fs` provider injection (`pi-vfs`), `ShellBuilderExt` builtin registration, `Repo` enum backend dispatch, `IsolationBackend` trait, settings layers (`docs/settings.md` + env) — prefer adding a provider/trait impl over branching call sites.

## Important Files

| Path | Role |
|---|---|
| `packages/coding-agent/src/cli.ts`, `src/main.ts`, `src/sdk.ts` | Boot flow, root command, session/SDK entry |
| `packages/coding-agent/DEVELOPMENT.md` | Dev map: `src/` layout + per-subsystem `docs/` links |
| `crates/pi-natives/src/lib.rs` | N-API boundary: module list, runtime install, version stamp |
| `Cargo.toml` (+ `rust-toolchain.toml`, `rustfmt.toml`) | 16-member workspace, 5 build profiles, clippy policy, nightly pin |
| `package.json` (+ `bunfig.toml`, `.oxlintrc.json`, `.oxfmtrc.json`) | Scripts catalog, Bun hoisted/exact/frozen config, lint/format policy |
| `MODULE.bazel`, `BUILD.bazel`, `.bazelrc` | CI/release native builds (9 addon targets), clippy/rustfmt configs |
| `deny.toml` | License/advisory gate (cargo-deny) |
| `docs/settings.md`, `docs/environment-variables.md`, `docs/tools/` | Config reference, env vars, per-tool contracts |
| `CONTRIBUTING.md` | PR rules: one logical change, human-written why, reproduce-then-verify |
| `Dockerfile`, `flake.nix`, `infra/` | Container, Nix, cluster/runner builds |

## Runtime/Tooling Preferences

Bun `>=1.4` (Docker pins `1.4.2`) is the driver — Node exists but never builds; npm/yarn/pnpm unsupported. Rust `nightly-2026-08-12` via rustup (Bazel uses its own pinned `nightly/2026-04-29`); stable Rust unsupported. Bazel `9.2.0` via bazelisk is source of truth for CI/release cross targets (linux-arm64/musl, win32, darwin); plain cargo is for local iteration. `bun install --frozen-lockfile` only (bare install rewrites `bun.lock`); 3-day minimum release age enforced; `@ark/schema` + `puppeteer-core` patches required. Lint/format: oxlint/oxfmt (not ESLint/Prettier), rustfmt+clippy, ruff for Python. Python `3.12` for `omp-rpc`/`robomp`. Docker needs BuildKit (`dockerfile:1.7-labs`).

## Testing & QA

Three runners, one pattern: fixture-backed behavioral tests, never assert internals or literal defaults.

| Stack | Runner | Run it |
|---|---|---|
| TS | `bun:test` via `scripts/ci-test-ts.ts` (buckets + sharding `OMP_TEST_SHARD=1/3`, watchdog) | `bun run test`, `bun run ci:test:ts[:workspace\|:native\|:coding-agent:*]`, per-package `bun test packages/<pkg>/test/` |
| Rust | `cargo-nextest` + doctests (excludes vendored `brush-core`, `cfg_aliases`); Bazel `//crates/...` in CI | `bun run test:rs` |
| Python | `pytest -x` | `bun run test:py`, integration `ROBOMP_INTEGRATION=1 … test_worker_smoke.py` |

Conventions: Rust `#[cfg(test)] mod tests` + `tests/` integration, `run_util::<T>()` (exit/stdout/stderr), `Host::for_test()`, `tempfile::tempdir()`, JSON fixtures in `tests/fixtures/`, `pretty_assertions`. TS co-located `*.test.ts`, `createMockModel()`, localhost fixture servers, parallel chunked execution. Python `conftest.py`, `monkeypatch`, `httpx.MockTransport`.

Coverage expectation: every PR exercises the changed path for real — `bun run check` plus relevant suites are necessary but not sufficient. Bug fix: reproduce before, confirm the same repro passes after. Feature: launch and use it end to end. UI: interact and inspect the render. Say the exact scenario + result in the PR body, in your own words.
