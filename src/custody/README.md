# Master-secret files

`BB_MASTER_SECRET_FILE` is opened read-only without following a final symlink.
The opened descriptor must be a regular file, at most 4096 bytes, owned by the
current process uid, with mode 0600 or stricter (0400 is supported). No group,
other or executable access is accepted. Checks precede reading secret bytes;
failures expose only `BROKER_UNAVAILABLE`. The daemon maps this to its redacted
master-secret diagnostic. Secret bytes remain verbatim, including newlines.

## Compose compatibility verification (R2)

Ran the shipped Compose service with the `docker/README.md` sequence: build,
create a throwaway named volume, provision only the encrypted envelope via stdin,
then up with file secrets and a read-only rootfs. Only test ports and an isolated
fake testnet RPC were overridden. The daemon reached ready, then reached ready
again after SIGKILL/restart; containers, network, image and volume were removed.

Runtime inspection on Docker Desktop (Linux engine 29.5.3) showed:

- host operator uid 501; daemon uid 1000;
- `/run/secrets/bb_master`: regular file, uid 1000, mode 0600;
- both secret bind mounts had `RW=false`;
- `broker.sqlite` was mode 0600.

Thus read-only Compose file secrets work without weakening the uid rule. Compose
file-secret ownership mapping is platform-dependent: on native Linux follow
`docker/README.md` and provision source files for uid 1000 (or the mapped daemon
uid). A root-owned 0600 file unreadable to the non-root daemon is not repaired or
accepted merely because it is mounted read-only. Do not use 0644 as a workaround.
Keep secret sources outside the repository in an operator-only 0700 directory.
