# Master-secret files

The daemon opens `BB_MASTER_SECRET_FILE` read-only and does not follow a symlink at the final path component. The opened descriptor must be a regular file of at most 4096 bytes, owned by the current process uid, with mode 0600 or stricter (0400 works). Group, other, and execute access are all refused. These checks run before any secret bytes are read. A failure reports only `BROKER_UNAVAILABLE`, which the daemon maps to its redacted master-secret diagnostic. The secret bytes are used verbatim, newlines included.

## Compose compatibility check (R2)

We ran the shipped Compose service through the `docker/README.md` sequence. We built the image, created a throwaway named volume, provisioned only the encrypted envelope over stdin, and started the service with file secrets and a read-only root filesystem. We overrode only the test ports and pointed the daemon at an isolated fake testnet RPC. The daemon became ready, and became ready again after a SIGKILL and restart. We then removed the containers, network, image, and volume.

Runtime inspection on Docker Desktop (Linux engine 29.5.3) showed:

- The host operator uid was 501 and the daemon uid was 1000.
- `/run/secrets/bb_master` was a regular file owned by uid 1000 with mode 0600.
- Both secret bind mounts had `RW=false`.
- `broker.sqlite` had mode 0600.

So read-only Compose file secrets work without weakening the uid rule. How Compose maps file-secret ownership depends on the platform. On native Linux, follow `docker/README.md` and create the source files for uid 1000, or for the mapped daemon uid. The daemon does not repair or accept a root-owned 0600 file that the non-root daemon cannot read, even though the mount is read-only. Do not use mode 0644 as a workaround. Keep secret source files outside the repository in a 0700 directory that only the operator can read.
