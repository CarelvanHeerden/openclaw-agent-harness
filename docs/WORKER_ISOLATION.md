# Worker isolation — what real containment would take

**Status: scoping only. Nothing here ships in `1.0.0-rc.3`.**

[SECURITY.md](../SECURITY.md#the-threat-model-stated-plainly) states the current position plainly: the bash guard is a speed bump built for a capable but non-adversarial worker, and it does not contain one that is trying to get out. An external review of `1.0.0-rc.2` recommended an OS-level sandbox — denied egress, read-only mounts, seccomp. That is the right target. This document is an honest account of what stands between here and there, so the next person to pick it up starts from the constraints rather than from the wish.

## Why the obvious fix does not work

The reflex is "run the worker in a container". The harness is already in one.

The harness runs as an OpenClaw plugin, inside the OpenClaw gateway process, inside whatever container the operator deployed. Workers are child processes of that. So every isolation mechanism has to be applied by an unprivileged process to its own children, from inside a container it does not control:

- **Docker-in-Docker** needs the docker socket. Mounting it into the gateway container hands the gateway root on the host, which is a larger hole than the one being closed.
- **seccomp / landlock** via `prctl` is applicable to self-and-children without privilege, and is Linux-only. A meaningful share of harness development and much of its smoke testing happens on macOS, where there is no equivalent. `sandbox-exec` exists on macOS, is deprecated, and is not a substitute.
- **User namespaces** need `CLONE_NEWUSER`, which the default Docker seccomp profile blocks. Operators would have to relax their container's own profile to let the harness tighten its children's, which is a hard thing to ask for and a worse posture if they get it wrong.
- **Network namespaces** for egress denial need `CAP_NET_ADMIN`. Same problem.

None of this is insurmountable, but all of it moves the requirement from "the harness sandboxes its workers" to "the operator deploys the harness a specific way and the harness enforces that they did". That is a deployment contract, not a code change, and it should be designed as one.

## The second constraint: the worker needs most of what you would take away

A worker's job is to change code and prove the change works. That means it must:

- **write to the worktree** — so a read-only filesystem is out; it has to be a scoped read-write mount with everything else read-only or absent;
- **run the repo's toolchain** — `npm ci`, `pytest`, `cargo build`. These are exactly the interpreters that make the bash guard advisory, and they cannot be removed;
- **reach the network** — `npm ci` hits a registry. Blanket egress denial breaks most real repositories. Egress control means a proxy with an allowlist (registries, the git remote, the Anthropic API), which is a component the harness does not have and would have to own, configure and keep current;
- **hold an Anthropic API key** — the embedded Claude Code binary needs it, and it is in the worker's environment for that reason.

So the achievable target is not "the worker can do nothing". It is: the worker sees only its worktree, reaches only an allowlisted set of hosts, and holds only credentials scoped to the task. Each of those is a separate piece of work with its own failure modes.

## What is worth doing first, if this is picked up

Ordered by value per unit of pain, not by completeness.

1. **Scope the Anthropic key.** The worker holds a key that can spend money. If Anthropic offers scoped or short-lived credentials, using one here costs little and removes the highest-value secret from the worker's reach. This is worth checking before any of the sandboxing below.
2. **Make the deployment contract explicit.** Document the container posture the harness expects (dedicated container, no docker socket, its own network policy, a machine user's tokens rather than a human's). Add a `harness_health` check that reports which of those hold at runtime. This is real risk reduction with no platform work, and it turns an assumption into something an operator can verify.
3. **Egress allowlist via proxy.** Point workers at an HTTP(S) proxy with an allowlisted host set and drop the direct route. This survives the interpreter problem — `python3` cannot route around a network policy the way it routes around a command filter — and it is the single control that most changes the threat model.
4. **Filesystem scoping on Linux via landlock**, behind a config flag, defaulting off, with a clear statement that macOS has no equivalent. Partial coverage honestly labelled beats none, provided the docs never imply the flag exists on platforms where it does not.

## What must not happen

Do not add settings that read like containment and are not. Every entry added to `bash_denylist_tokens` or `path_denylist` while `python3` is whitelisted increases apparent safety and changes actual safety by nothing. That gap — between what the configuration implies and what it enforces — is what the external review found, and it is worse than having no setting at all, because someone will rely on it.

Until an OS boundary exists, the honest control is the one in SECURITY.md: run the harness where a compromised worker is survivable, and keep its tokens narrow.
